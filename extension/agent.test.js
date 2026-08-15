// agent.js touches the page only through window.ApplyGoDom, so it's tested here with a mock DOM
// layer (plain spy functions) rather than jsdom -- what's under test is the agent's own state
// machine, not real browser behavior (content.test.js already covers that).
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function spy(impl) {
  const fn = (...args) => { fn.calls.push(args); return impl ? impl(...args) : undefined; };
  fn.calls = [];
  return fn;
}

/** A minimal ApplyGoDom double. Each field name in `verifyResults` maps to what verify_field
 * should report *this call* -- tests mutate it mid-run to simulate a field regressing between an
 * earlier fill and final review, without needing a real DOM to regress in. */
function makeDom({ visibleFields = [], verifyResults = {} } = {}) {
  return {
    readForm: spy(() => visibleFields),
    fillField: spy(async () => true),
    verifyField: spy((name) => verifyResults[name] ?? { ok: true, actual: '' }),
    scrollToField: spy(() => true),
    highlightField: spy(() => true),
    markMissing: spy(() => true),
    markResult: spy(() => true),
    attachResumeFromBase64: spy(() => ({ ok: true, name: 'resume' })),
    verifyResumeAttached: spy(() => ({ ok: true })),
    fillCoverLetter: spy(() => ({ ok: true, name: 'cover' })),
    discoverComboboxOptions: spy(async () => []),
    readValidationErrors: spy(() => []),
    pageUrl: () => 'https://example.com/apply',
  };
}

function loadAgentJs(dom) {
  const context = {
    window: { ApplyGoDom: dom },
    chrome: { runtime: { sendMessage: async () => ({ ok: true, data: {} }) } },
    location: { href: 'https://example.com/apply' },
    console,
    setTimeout,
    clearTimeout,
    Promise,
  };
  vm.createContext(context);
  const src = fs.readFileSync(path.join(DIR, 'agent.js'), 'utf8');
  vm.runInContext(src, context, { filename: 'agent.js' });
  return context.window.ApplyGoAgent;
}

import assert from 'node:assert/strict';
import test from 'node:test';

test('finalReview: a field that regresses since it was filled loses its verified status', async () => {
  const dom = makeDom({
    visibleFields: [{ name: 'relocate', label: 'Willing to relocate?', type: 'select', required: true, filled: false, options: ['Yes', 'No'] }],
    verifyResults: { relocate: { ok: false, reason: 'option_not_selected' } },
  });
  const agent = loadAgentJs(dom);
  agent.state.fields = [
    { name: 'relocate', label: 'Willing to relocate?', type: 'select', required: true, status: 'verified', value: 'Yes' },
  ];

  await agent.finalReview();

  const field = agent.state.fields.find((f) => f.name === 'relocate');
  assert.equal(field.status, 'failed', 'a field final validation finds is no longer set must not stay "verified"');

  const markResultCalls = dom.markResult.calls.filter(([name]) => name === 'relocate');
  assert.ok(markResultCalls.some(([, ok]) => ok === false), 'the outline must be repainted red, not left green');

  assert.equal(agent.state.finalReport.clean, false, 'Application Progress and Final Check must not disagree');
  assert.ok(agent.state.finalReport.didNotStick.some((f) => f.name === 'relocate'));
});

test('finalReview: a field that still verifies stays verified and counted as filled', async () => {
  const dom = makeDom({
    visibleFields: [{ name: 'email', label: 'Email', type: 'text', required: true, filled: true, options: [] }],
    verifyResults: { email: { ok: true, actual: 'a@b.com' } },
  });
  const agent = loadAgentJs(dom);
  agent.state.fields = [
    { name: 'email', label: 'Email', type: 'text', required: true, status: 'verified', value: 'a@b.com' },
  ];

  await agent.finalReview();

  const field = agent.state.fields.find((f) => f.name === 'email');
  assert.equal(field.status, 'verified');
  assert.equal(agent.state.finalReport.filled, 1);
  assert.equal(agent.state.finalReport.clean, true);
});

test('finalReview: a resume that was selected but never verified as attached keeps the report unclean', async () => {
  const dom = makeDom({ visibleFields: [] });
  const agent = loadAgentJs(dom);
  agent.state.fields = [];
  agent.state.assets = { resume: true, resumeAttached: false, resumeVerified: false };

  await agent.finalReview();

  assert.equal(agent.state.finalReport.clean, false, 'an unverified resume is not a clean finish');
  assert.equal(agent.state.finalReport.resumeSelected, true);
  assert.equal(agent.state.finalReport.resumeVerified, false);
});

test('explainWhyAsking: distinguishes a known-but-rejected answer from a genuinely unknown one', () => {
  const agent = loadAgentJs(makeDom());
  const known = agent.explainWhyAsking({ status: 'failed', value: 'Yes', sensitive: false });
  const unknown = agent.explainWhyAsking({ status: 'needs_user', value: '', sensitive: false });
  assert.match(known, /"Yes"/, 'must reference the answer ApplyGo already knows');
  assert.doesNotMatch(unknown, /"[^"]+"/, 'nothing to quote when no answer is known yet');
  assert.notEqual(known, unknown);
});
