// Regression coverage for the dropdown bug: a field whose real options weren't read correctly, or
// whose selection didn't actually register with the employer's form, is exactly the "ApplyGo thinks
// it's done but the form disagrees" failure this whole feature exists to prevent. See content.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContentJs } from './test-helpers.js';

// content.js runs inside a jsdom window -- a separate realm with its own Array constructor. Values
// it returns are correct but assert.deepEqual can misreport a mismatch comparing across realms;
// re-homing into a plain Node array here is the standard fix, not a workaround for a real bug.
const plain = (arr) => Array.from(arr);

test('native <select>: detected, real options extracted, placeholder dropped', () => {
  const { ApplyGoDom } = loadContentJs(`
    <label for="country">Country</label>
    <select id="country" name="country">
      <option value="">Please select</option>
      <option value="us">United States</option>
      <option value="ca">Canada</option>
    </select>
  `);
  const fields = ApplyGoDom.readForm();
  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, 'select');
  assert.deepEqual(plain(fields[0].options), ['United States', 'Canada']);
});

test('ARIA combobox: detected via role=combobox + aria-controls, options read from its listbox', () => {
  const { ApplyGoDom } = loadContentJs(`
    <input aria-label="Are you open to relocation?" role="combobox" aria-haspopup="listbox"
      aria-controls="rel-listbox" aria-expanded="false" name="relocate">
    <ul id="rel-listbox" role="listbox">
      <li role="option">Yes</li>
      <li role="option">No</li>
    </ul>
  `);
  const fields = ApplyGoDom.readForm();
  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, 'select');
  assert.deepEqual(plain(fields[0].options), ['Yes', 'No']);
});

test('ARIA combobox: a listbox that has not mounted yet reads as select-typed with no options, not text', () => {
  // react-select and similar libraries only mount the listbox once the control is opened -- a
  // background scan has to still recognize this as a picker, not silently downgrade it to free text.
  const { ApplyGoDom } = loadContentJs(`
    <input aria-label="Country" role="combobox" aria-haspopup="listbox" aria-controls="not-mounted-yet" name="country">
  `);
  const fields = ApplyGoDom.readForm();
  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, 'select');
  assert.deepEqual(plain(fields[0].options), []);
});

test('button+dialog combobox (intl-tel-input\'s country picker pattern): detected, labeled via aria-labelledby, filled by click, and verified via aria-label', async () => {
  // Distinct from the react-select pattern above: the visible, clickable trigger is a <button>
  // with aria-haspopup="dialog" (not an <input> with aria-haspopup="listbox"), it has neither name
  // nor id of its own, its aria-label is a placeholder ("No country selected") rather than the
  // field's question, and after a selection it reflects the choice only in that same aria-label
  // (a flag icon, not readable text) -- every one of those broke the original detection/labeling/
  // verification logic, one at a time, while chasing this exact real-world Greenhouse field.
  const { ApplyGoDom, window } = loadContentJs(`
    <label id="country-label">Country</label>
    <button type="button" aria-labelledby="country-label" aria-haspopup="dialog" aria-expanded="false"
      aria-controls="dd-content" aria-label="No country selected"></button>
    <div id="dd-content" role="dialog" aria-modal="true" style="display:none">
      <div role="listbox">
        <li role="option" data-country-code="us">United States</li>
        <li role="option" data-country-code="ca">Canada</li>
      </div>
    </div>
  `);
  const button = window.document.querySelector('button');
  // Simulates what these widgets actually do on selection -- a static fixture's <li role="option">
  // has no real click behavior of its own to update anything.
  window.document.querySelectorAll('[role="option"]').forEach((li) => {
    li.addEventListener('click', () => button.setAttribute('aria-label', `${li.textContent} selected`));
  });

  const fields = ApplyGoDom.readForm();
  assert.equal(fields.length, 1, 'the button must be recognized as a field even with no name/id of its own');
  assert.equal(fields[0].label, 'Country', 'must follow aria-labelledby, not fall back to the placeholder aria-label');
  assert.equal(fields[0].type, 'select');
  assert.deepEqual(plain(fields[0].options), ['United States', 'Canada']);
  assert.equal(fields[0].filled, false, 'a non-empty placeholder aria-label must never read as already filled');

  const ok = await ApplyGoDom.fillField(fields[0].name, 'usa');
  assert.equal(ok, true, 'a synonym match ("usa") must resolve through a button trigger the same as through an input one');

  const check = ApplyGoDom.verifyField(fields[0].name, 'usa');
  assert.equal(check.ok, true, 'verification must accept the post-selection aria-label as evidence, not just visible text or .value');
});

test('react-select without aria-controls: menu and selected-value text render as siblings several levels up, not inside the input\'s own narrow wrapper', async () => {
  // Pulled directly from a real Greenhouse "Country" field that kept failing after the earlier
  // react-select fix: this specific instance has no aria-controls/aria-owns at all (contradicting
  // what the library's own source suggested elsewhere), and its open menu + selected-value text
  // both render as siblings of "select__control", not descendants of the input's immediate
  // "select__input-container" wrapper -- the exact wrapper comboboxListbox()'s old single-level
  // .closest() lookup would have matched and then found nothing useful inside.
  const { ApplyGoDom, window } = loadContentJs(`
    <label id="country-label">Country</label>
    <div class="select__control">
      <div class="select__value-container">
        <div class="select__input-container" data-value="">
          <input class="select__input" id="country" type="text" tabindex="0"
            aria-autocomplete="list" aria-expanded="false" aria-haspopup="true"
            aria-labelledby="country-label" aria-required="false" role="combobox" value="">
        </div>
      </div>
    </div>
  `);

  const input = window.document.getElementById('country');
  // Simulates react-select's real behavior: the menu mounts as a sibling of select__control on
  // open, and picking an option renders the selected label as a sibling of the input's own
  // container rather than inside it.
  input.addEventListener('click', () => {
    if (window.document.querySelector('.select__menu')) return;
    const menu = window.document.createElement('div');
    menu.className = 'select__menu';
    menu.setAttribute('role', 'listbox');
    menu.innerHTML = '<div role="option">United States</div><div role="option">Canada</div>';
    window.document.querySelector('.select__control').insertAdjacentElement('afterend', menu);
  });
  window.document.addEventListener('click', (event) => {
    if (event.target.getAttribute && event.target.getAttribute('role') === 'option') {
      const valueContainer = window.document.querySelector('.select__value-container');
      const singleValue = window.document.createElement('div');
      singleValue.className = 'select__single-value';
      singleValue.textContent = event.target.textContent;
      valueContainer.insertBefore(singleValue, valueContainer.firstChild);
      window.document.querySelector('.select__menu')?.remove();
    }
  });

  const fields = ApplyGoDom.readForm();
  assert.equal(fields.length, 1);
  assert.equal(fields[0].label, 'Country');

  const ok = await ApplyGoDom.fillField(fields[0].name, 'usa');
  assert.equal(ok, true, 'must find the menu by walking outward, not just the nearest "select"-classed ancestor');

  const check = ApplyGoDom.verifyField(fields[0].name, 'usa');
  assert.equal(check.ok, true, 'must find the selected-value text as a sibling, not require it inside the input\'s own container');
  assert.equal(check.actual, 'United States');
});

test('hidden shadow input sharing an attribute with the visible combobox: the visible one always wins', async () => {
  // The exact bug behind "it shows me the options, I pick one, it still doesn't accept it": a real
  // Greenhouse field had a hidden <input name="country"> holding the actual submitted value
  // alongside the visible combobox, which had id="country" but no name of its own. readForm()
  // correctly scans the visible element directly and reports its real options -- but resolving
  // "country" back to an element by name-then-id as two separate sequential tiers found the hidden
  // input first (it matched on name) and never even looked at the visible one (which only matches
  // on id), so every fill silently targeted an element that can't actually be clicked or read.
  const { ApplyGoDom, window } = loadContentJs(`
    <label id="country-label">Country</label>
    <input type="hidden" name="country" value="">
    <div class="select__control">
      <div class="select__value-container">
        <div class="select__input-container" data-value="">
          <input class="select__input" id="country" type="text" tabindex="0"
            aria-autocomplete="list" aria-expanded="false" aria-haspopup="true"
            aria-labelledby="country-label" aria-required="false" role="combobox" value="">
        </div>
      </div>
    </div>
  `);

  const input = window.document.getElementById('country');
  input.addEventListener('click', () => {
    if (window.document.querySelector('.select__menu')) return;
    const menu = window.document.createElement('div');
    menu.className = 'select__menu';
    menu.setAttribute('role', 'listbox');
    menu.innerHTML = '<div role="option">United States+1</div><div role="option">Canada+1</div>';
    window.document.querySelector('.select__control').insertAdjacentElement('afterend', menu);
  });
  window.document.addEventListener('click', (event) => {
    if (event.target.getAttribute && event.target.getAttribute('role') === 'option') {
      const valueContainer = window.document.querySelector('.select__value-container');
      const singleValue = window.document.createElement('div');
      singleValue.className = 'select__single-value';
      singleValue.textContent = event.target.textContent;
      valueContainer.insertBefore(singleValue, valueContainer.firstChild);
      window.document.querySelector('.select__menu')?.remove();
    }
  });

  const fields = ApplyGoDom.readForm();
  assert.equal(fields.length, 1, 'the hidden shadow input must not also be read as its own separate field');

  const ok = await ApplyGoDom.fillField(fields[0].name, 'United States+1');
  assert.equal(ok, true, 'must resolve to the visible combobox, not the hidden input matched by name');

  const check = ApplyGoDom.verifyField(fields[0].name, 'United States+1');
  assert.equal(check.ok, true);
});

test('fillField: exact option match on a native <select> selects it, dispatches change, and verifies', () => {
  const { ApplyGoDom, window } = loadContentJs(`
    <select name="country">
      <option value="">Please select</option>
      <option value="us">United States</option>
      <option value="ca">Canada</option>
    </select>
  `);
  const select = window.document.querySelector('select');
  let changeEvents = 0;
  select.addEventListener('change', () => { changeEvents++; });

  return ApplyGoDom.fillField('country', 'United States').then((ok) => {
    assert.equal(ok, true, 'fillField should report success');
    assert.equal(select.value, 'us');
    assert.equal(changeEvents, 1, 'a real change event must fire so a React-controlled select sees it');
    const check = ApplyGoDom.verifyField('country', 'United States');
    assert.equal(check.ok, true);
  });
});

test('fillField: normalized/synonym match ("usa" -> "United States") resolves unambiguously', async () => {
  const { ApplyGoDom } = loadContentJs(`
    <select name="country">
      <option value="">Please select</option>
      <option value="us">United States</option>
      <option value="ca">Canada</option>
    </select>
  `);
  const ok = await ApplyGoDom.fillField('country', 'usa');
  assert.equal(ok, true);
  const check = ApplyGoDom.verifyField('country', 'usa');
  assert.equal(check.ok, true);
});

test('fillField: synonym match still resolves when the real option is decorated with extra text', async () => {
  // Real Greenhouse options weren't bare country names -- a combined country/dial-code picker
  // rendered "United States+1", not "United States", and the old exact-equality-only synonym check
  // missed it entirely even though the match was unambiguous.
  const { ApplyGoDom, window } = loadContentJs(`
    <select name="country">
      <option value="">Please select</option>
      <option value="us">United States+1</option>
      <option value="ca">Canada+1</option>
      <option value="af">Afghanistan+93</option>
    </select>
  `);
  const ok = await ApplyGoDom.fillField('country', 'USA');
  assert.equal(ok, true);
  assert.equal(window.document.querySelector('select').value, 'us');
});

test('fillField: still refuses to guess when a decorated option text makes the synonym ambiguous', async () => {
  const { ApplyGoDom } = loadContentJs(`
    <select name="country">
      <option value="">Please select</option>
      <option value="us">United States+1</option>
      <option value="um">United States Minor Outlying Islands+246</option>
    </select>
  `);
  const ok = await ApplyGoDom.fillField('country', 'USA');
  assert.equal(ok, false, 'both options contain "united states" -- must not silently pick one');
});

test('fillField: case-insensitive yes/no synonym match on a radio group', async () => {
  const { ApplyGoDom } = loadContentJs(`
    <fieldset>
      <legend>Are you authorized to work in the US?</legend>
      <label><input type="radio" name="work_auth" value="yes_val"> Yes</label>
      <label><input type="radio" name="work_auth" value="no_val"> No</label>
    </fieldset>
  `);
  const ok = await ApplyGoDom.fillField('work_auth', 'yes');
  assert.equal(ok, true);
  const check = ApplyGoDom.verifyField('work_auth', 'yes');
  assert.equal(check.ok, true);
  assert.equal(check.actual, 'Yes');
});

test('fillField: an ambiguous partial match refuses to guess rather than picking one', async () => {
  const { ApplyGoDom } = loadContentJs(`
    <select name="location">
      <option value="">Please select</option>
      <option value="us-remote">United States - Remote</option>
      <option value="us-sf">United States - San Francisco</option>
    </select>
  `);
  // "United States" is a substring of both real options and matches neither exactly -- this must
  // come back false, not silently pick the first one.
  const ok = await ApplyGoDom.fillField('location', 'United States');
  assert.equal(ok, false);
});

test('fillField: no matching option at all is a failed selection, not a crash', async () => {
  const { ApplyGoDom } = loadContentJs(`
    <select name="country">
      <option value="">Please select</option>
      <option value="us">United States</option>
    </select>
  `);
  const ok = await ApplyGoDom.fillField('country', 'Antarctica');
  assert.equal(ok, false);
  const check = ApplyGoDom.verifyField('country', 'Antarctica');
  assert.equal(check.ok, false);
});

test('verifyField: reports nothing_selected for a radio group where nothing was ever picked', () => {
  const { ApplyGoDom } = loadContentJs(`
    <label><input type="radio" name="relocate" value="yes"> Yes</label>
    <label><input type="radio" name="relocate" value="no"> No</label>
  `);
  const check = ApplyGoDom.verifyField('relocate', 'yes');
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'nothing_selected');
});

test('markResult: paints a distinct color for verified vs failed, not the same one fillField uses', () => {
  const { ApplyGoDom, window } = loadContentJs(`<select name="country"><option value="us">US</option></select>`);
  const el = window.document.querySelector('select');
  ApplyGoDom.markResult('country', true);
  const verifiedOutline = el.style.outline;
  ApplyGoDom.markResult('country', false);
  const failedOutline = el.style.outline;
  assert.ok(verifiedOutline, 'a verified result should leave a visible outline');
  assert.ok(failedOutline, 'a failed result should leave a visible outline');
  assert.notEqual(verifiedOutline, failedOutline, 'success and failure must be visually distinguishable');
});

test('markMissing: uses a third, distinct color from both markResult states', () => {
  const { ApplyGoDom, window } = loadContentJs(`<select name="country"><option value="us">US</option></select>`);
  const el = window.document.querySelector('select');
  ApplyGoDom.markResult('country', true);
  const verifiedOutline = el.style.outline;
  ApplyGoDom.markMissing('country');
  const missingOutline = el.style.outline;
  assert.notEqual(verifiedOutline, missingOutline);
});
