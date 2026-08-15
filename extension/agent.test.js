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
 * earlier fill and final review, without needing a real DOM to regress in. `fillField`/
 * `verifyField` can be overridden entirely for tests that need different behavior across
 * successive calls (a failed direct attempt followed by a successful retry, say). */
function makeDom({ visibleFields = [], verifyResults = {}, fillField, verifyField } = {}) {
  return {
    readForm: spy(() => visibleFields),
    fillField: spy(fillField || (async () => true)),
    verifyField: spy(verifyField || ((name) => verifyResults[name] ?? { ok: true, actual: '' })),
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

/** `onMessage` lets a test answer specific API calls (chiefly /applications/resolve-option)
 * differently from the default no-op success every other call gets. */
function loadAgentJs(dom, { onMessage } = {}) {
  const context = {
    window: { ApplyGoDom: dom },
    chrome: { runtime: { sendMessage: onMessage || (async () => ({ ok: true, data: {} })) } },
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

test('fillAndVerify: retries once via model-assisted resolution when a choice fill fails, using the resolved option', async () => {
  const dom = makeDom({
    fillField: async (name, value) => value === 'United States+1',
    verifyField: (name, expected) => (expected === 'United States+1' ? { ok: true, actual: expected } : { ok: false, reason: 'option_not_selected' }),
  });
  let resolveCalledWith = null;
  const agent = loadAgentJs(dom, {
    onMessage: async (msg) => {
      if (msg.path === '/applications/resolve-option') {
        resolveCalledWith = msg.body;
        return { ok: true, data: { option: 'United States+1', confident: true } };
      }
      return { ok: true, data: {} };
    },
  });

  const field = { name: 'country', label: 'Country', type: 'select', options: ['United States+1', 'Canada+1'] };
  const result = await agent.fillAndVerify(field, 'USA');

  assert.equal(result.check.ok, true);
  assert.equal(result.value, 'United States+1', 'the value actually used should be what got filled, not the raw answer that failed');
  assert.equal(dom.fillField.calls.length, 2, 'one failed direct attempt, one retry with the resolved value');
  // agent.js runs in a separate vm context with its own Object/Array realm -- round-tripping
  // through JSON re-homes the payload into this file's own realm before comparing, the same fix
  // content.test.js needed for the same reason.
  assert.deepEqual(JSON.parse(JSON.stringify(resolveCalledWith)), { label: 'Country', value: 'USA', options: ['United States+1', 'Canada+1'] });
});

test('fillAndVerify: never attempts resolution for a plain text field, and treats an unconfident resolution as still failed', async () => {
  const dom = makeDom({ fillField: async () => false, verifyField: () => ({ ok: false, reason: 'fill_failed' }) });
  let resolveCalls = 0;
  const agent = loadAgentJs(dom, {
    onMessage: async (msg) => {
      if (msg.path === '/applications/resolve-option') { resolveCalls++; return { ok: true, data: { option: null, confident: false } }; }
      return { ok: true, data: {} };
    },
  });

  const textField = { name: 'summary', label: 'Summary', type: 'textarea', options: [] };
  await agent.fillAndVerify(textField, 'some text');
  assert.equal(resolveCalls, 0, 'a plain text field has no options to resolve against, so this must never even try');

  const choiceField = { name: 'country', label: 'Country', type: 'select', options: ['United States+1', 'Canada+1'] };
  const result = await agent.fillAndVerify(choiceField, 'Elbonia');
  assert.equal(resolveCalls, 1, 'a choice field with real options should still attempt resolution once the direct fill fails');
  assert.equal(result.check.ok, false, 'an unconfident resolution must not be treated as success');
  assert.equal(result.value, 'Elbonia', 'nothing was substituted since resolution never confidently matched anything');
});

test('explainWhyAsking: distinguishes a known-but-rejected answer from a genuinely unknown one', () => {
  const agent = loadAgentJs(makeDom());
  const known = agent.explainWhyAsking({ status: 'failed', value: 'Yes', sensitive: false });
  const unknown = agent.explainWhyAsking({ status: 'needs_user', value: '', sensitive: false });
  assert.match(known, /"Yes"/, 'must reference the answer ApplyGo already knows');
  assert.doesNotMatch(unknown, /"[^"]+"/, 'nothing to quote when no answer is known yet');
  assert.notEqual(known, unknown);
});
