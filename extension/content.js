// The DOM layer: everything that reads or mutates the employer's page.
//
// Reading the live DOM rather than an ATS API is the whole reason this is an extension: it works on
// any form, including ones ApplyGo has never seen, and it sees exactly what the candidate sees. The
// tradeoff is that selectors have to be generic, so everything below keys off structure and labels
// rather than per-vendor class names.
//
// This file never decides *what* to fill -- that's agent.js. It exposes a fixed set of actions the
// agent is allowed to take (window.ApplyGoDom), so the agent reasons over structured state and
// deterministic code owns every actual browser mutation. Nothing here ever submits a form.

// Four states, one meaning each -- a field's outline should answer "what is ApplyGo doing here"
// at a glance, the same way for a dropdown as for a text box:
//   blue   = actively being worked on right now (highlightField, during a fill attempt)
//   green  = filled AND verified against the live DOM (only painted after verify_field succeeds)
//   amber  = ApplyGo needs the candidate's answer
//   red    = ApplyGo attempted a fill but verification found it didn't stick
const ACTIVE_OUTLINE = '3px solid #4f46e5';
const VERIFIED_OUTLINE = '2px solid #16a34a';
const MISSING_OUTLINE = '2px dashed #d97706';
const FAILED_OUTLINE = '2px solid #dc2626';

/** The visible question for a control, tried in the order that actually works most often. */
function labelFor(el) {
  // aria-labelledby is how accessible custom widgets (a combobox trigger button chief among them)
  // most often declare their real label -- checked ahead of aria-label, which on a button like
  // that is more often its own placeholder text ("No country selected") than the field's question.
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy.split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((n) => n.textContent)
      .join(' ');
    if (clean(text)) return clean(text);
  }
  if (el.id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (explicit) return clean(explicit.textContent);
  }
  const wrapping = el.closest('label');
  if (wrapping) return clean(wrapping.textContent);

  // Common ATS pattern: the label is a sibling heading inside a shared field container.
  const container = el.closest('div,fieldset,section');
  if (container) {
    const heading = container.querySelector('label,legend,.label,[class*="label"]');
    if (heading && !heading.contains(el)) return clean(heading.textContent);
  }
  return clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '');
}

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/\*$/, '').trim().slice(0, 300);
}

function isVisible(el) {
  if (el.type === 'hidden' || el.disabled) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return el.getClientRects().length > 0;
}

/**
 * Every answerable control on the page, as a flat field list.
 *
 * Radio groups collapse to one field keyed by their shared name, because "Are you authorized to
 * work in the US? Yes/No" is one question, not two, and the answer bank should store it as one.
 */
function readForm() {
  const fields = [];
  const seenRadioGroups = new Set();

  // input/select/textarea covers native controls. button[aria-haspopup] and [role="combobox"] cover
  // the other shape a picker takes: a plain button (no name/value of its own -- the real answer
  // lives behind whatever it opens) that declares via standard ARIA, not a vendor class name, that
  // clicking it reveals a dialog/listbox/menu of choices. Some libraries (intl-tel-input's country
  // picker among them) build their trigger this way instead of react-select's input-based one.
  document.querySelectorAll('input, select, textarea, button[aria-haspopup], [role="combobox"]').forEach((el) => {
    if (!isVisible(el)) return;
    const triggerButton = el.tagName === 'BUTTON' && isComboboxTrigger(el);
    if (!triggerButton && ['submit', 'button', 'reset', 'search'].includes(el.type)) return;
    // The sidebar is injected into this same page; its own controls are not part of the employer's
    // application and must never be read as fields or filled.
    if (el.closest('#applygo-agent-root')) return;

    // A trigger button rarely has its own name/id -- the actual value it controls lives in a
    // hidden input or internal state elsewhere. Its aria-controls target is the one thing
    // guaranteed unique and stable per instance, so it stands in as the field's identity.
    const name = el.name || el.id || (triggerButton ? el.getAttribute('aria-controls') : '') || '';
    if (!name) return;

    if (el.type === 'radio') {
      if (seenRadioGroups.has(name)) return;
      seenRadioGroups.add(name);
      const group = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)];
      fields.push({
        name,
        label: groupLabel(group[0]) || labelFor(group[0]),
        type: 'radio',
        required: group.some((r) => r.required),
        options: group.map((r) => labelFor(r) || r.value).filter(Boolean),
        filled: group.some((r) => r.checked),
      });
      return;
    }

    if (el.tagName === 'SELECT') {
      fields.push({
        name,
        label: labelFor(el),
        type: 'select',
        required: el.required,
        options: [...el.options].filter(isRealOption).map((o) => o.textContent.trim()),
        filled: Boolean(el.value) && isRealOption(el.selectedOptions[0] || {}),
      });
      return;
    }

    // A styled "fake dropdown" -- react-select and similar libraries most ATS forms use put a real
    // <input> inside the control (for typing/filtering) rather than a native <select>, so without
    // this it would fall through to the generic text branch below with no options at all. Tagged as
    // 'select' unconditionally, even when no options are discoverable yet: most of these libraries
    // (react-select included) only mount the actual listbox once the control is clicked open, so a
    // background read here routinely finds nothing -- the type still has to say "this is a picker"
    // so discoverComboboxOptions() knows to try harder right before the candidate is actually asked
    // about it, rather than this quietly turning into a plain text field.
    if (isComboboxTrigger(el)) {
      // A trigger button has no .value of its own, and its placeholder text ("No country
      // selected") is often not empty -- there's no reliable way to tell "shows a placeholder"
      // from "shows a real choice" without per-vendor knowledge. Reporting false here in the
      // uncertain case is the safe direction: worst case is one redundant, harmless fill+verify
      // pass; reporting true when it's actually still blank would make a required field silently
      // invisible to the whole pipeline forever, which is the exact bug this exists to fix.
      const filled = el.tagName === 'BUTTON' ? false : Boolean(String(el.value || '').trim());
      fields.push({
        name,
        label: labelFor(el),
        type: 'select',
        required: el.required || el.getAttribute('aria-required') === 'true',
        options: comboboxOptions(el),
        filled,
      });
      return;
    }

    fields.push({
      name,
      label: labelFor(el),
      type: el.type === 'file' ? 'file' : el.tagName === 'TEXTAREA' ? 'textarea' : el.type || 'text',
      required: el.required,
      options: [],
      maxLength: maxLengthOf(el),
      filled: el.type === 'checkbox' ? el.checked : Boolean(String(el.value || '').trim()),
    });
  });

  return fields.filter((f) => f.label);
}

/** The employer's own character cap for a text/textarea field, when it declared one. */
function maxLengthOf(el) {
  const value = el.maxLength;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Drops the leading "Please select" style placeholder so it never gets offered as a real answer.
 * Checks both conventions: a blank value attribute (how well-authored forms mark it) and the
 * handful of placeholder phrasings that show up when the value is just the label text.
 */
function isRealOption(option) {
  const text = (option.textContent || '').trim();
  if (!text) return false;
  if (option.value === '') return false;
  return !/^(--\s*)?(please\s+)?(select|choose)\b/i.test(text);
}

/** For a radio group the real question usually sits above the individual option labels. */
function groupLabel(radio) {
  const container = radio.closest('fieldset,div[role="group"],div');
  if (!container) return '';
  const legend = container.querySelector('legend,label,.label,[class*="label"]');
  return legend ? clean(legend.textContent) : '';
}

/**
 * Conservative equivalence groups for the handful of ways an employer's option text and ApplyGo's
 * saved answer legitimately mean the same thing but aren't spelled the same. Membership in the same
 * group is the only thing that counts as a match here -- there is no fuzzy/similarity scoring, since
 * that is exactly the kind of thing that could quietly turn "US" into the wrong country.
 */
const ANSWER_SYNONYMS = [
  ['yes', 'y', 'true', 'i agree', 'agree'],
  ['no', 'n', 'false', 'i disagree', 'disagree'],
  ['usa', 'us', 'u.s.', 'u.s.a.', 'united states', 'united states of america'],
  ['uk', 'u.k.', 'united kingdom', 'great britain'],
];

function synonymGroup(text) {
  const norm = text.trim().toLowerCase();
  return ANSWER_SYNONYMS.find((group) => group.includes(norm)) || null;
}

/**
 * The one option a saved answer resolves to, or null if it doesn't resolve cleanly -- used by every
 * matcher below (radio, native select, combobox) so "don't guess when it's ambiguous" is enforced in
 * exactly one place rather than three slightly different ones. Two tiers, each required to be
 * unambiguous on its own: an exact-or-synonym match first (safe even with several options, since
 * "yes"/"Yes" is unambiguous even if the group happens to also list "No"), then a plain substring
 * match only when exactly one option contains it. More than one candidate at either tier is treated
 * the same as zero: nothing is selected, and the caller reports a failed fill rather than picking one.
 */
function findOptionMatch(options, want, textOf) {
  const wantNorm = String(want ?? '').trim().toLowerCase();
  if (!wantNorm) return null;
  const group = synonymGroup(wantNorm);
  const exact = options.filter((o) => {
    const t = textOf(o).trim().toLowerCase();
    // Containment, not just equality, against a synonym group member -- a real option is routinely
    // decorated with something extra ("United States+1" for a combined country/dial-code picker),
    // and requiring an exact match against "united states" would miss it entirely even though the
    // match is unambiguous. Still never a plain substring of the raw answer at this tier: matching
    // only through a *known* synonym group keeps "US" from ever resolving to an unrelated option
    // that merely happens to contain those two letters.
    return t === wantNorm || Boolean(group && group.some((g) => t === g || t.includes(g)));
  });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const partial = options.filter((o) => textOf(o).trim().toLowerCase().includes(wantNorm));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * The container a field's visual state (outline, scroll target) should apply to -- one definition
 * shared by every mark/highlight/scroll call so a dropdown or combobox gets exactly the same
 * treatment a plain input does, never gated on the element being a specific tag.
 */
function fieldContainer(el) {
  return el.closest('label,fieldset,div[role="group"],[class*="select" i],[class*="dropdown" i],[class*="combobox" i],div') || el;
}

/** A styled "fake dropdown" -- react-select and similar libraries most ATS forms use for this. */
function isComboboxTrigger(el) {
  if (el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete')) return true;
  // Any non-false WAI-ARIA haspopup value means "activating this opens an overlay of choices" --
  // react-select's input-based combobox uses listbox; intl-tel-input's country-picker button uses
  // dialog for its whole flag/search/list panel. Neither is a text field either way.
  const popup = el.getAttribute('aria-haspopup');
  return Boolean(popup && popup !== 'false');
}

/**
 * Ancestors of an element, nearest first, up to a bounded depth -- shared by comboboxListbox and
 * verifyField's combobox branch, both of which need to look outward from the control for state
 * (an open listbox, the visible selected-value text) that a real form often renders as a sibling of
 * some ancestor rather than a descendant of the nearest narrowly-classed wrapper around the control
 * itself.
 */
function ancestors(el, maxDepth) {
  const nodes = [];
  let node = el.parentElement;
  for (let depth = 0; node && depth < maxDepth; depth++, node = node.parentElement) nodes.push(node);
  return nodes;
}

/**
 * The listbox behind a combobox, found via the ARIA relationship the library itself declares
 * (`aria-controls`/`aria-owns` pointing at a `role="listbox"`) rather than any vendor-specific class
 * name. Not every instance of a given library actually sets that reference -- react-select only
 * adds aria-controls under some configurations, and a real Greenhouse field was found missing it
 * entirely -- so this also walks up from the input a few levels, since the open menu is typically
 * rendered as a sibling of an ancestor one or two levels up (react-select's own `select__control`,
 * for instance), not necessarily inside the *nearest* ancestor whose own class happens to mention
 * "select" (a narrower inner wrapper like `select__input-container` routinely is not).
 */
function comboboxListbox(el) {
  const listboxId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  if (listboxId) {
    const byId = document.getElementById(listboxId);
    if (byId) return byId;
  }
  for (const node of ancestors(el, 6)) {
    const listbox = node.querySelector('[role="listbox"]');
    if (listbox) return listbox;
  }
  // Last resort: some libraries portal the open menu straight onto <body>, entirely outside the
  // control's own DOM subtree. This is only ever called right after this specific control was
  // clicked open (see fillCombobox/discoverComboboxOptions), and opening one dropdown normally
  // closes any other that was already open, so the one listbox in the whole document at that
  // moment is a reasonable bet.
  return document.querySelector('[role="listbox"]');
}

/** The clickable option nodes behind a combobox, when the listbox is already in the DOM. */
function comboboxOptionElements(el) {
  const listbox = comboboxListbox(el);
  return listbox ? [...listbox.querySelectorAll('[role="option"]')] : [];
}

function comboboxOptions(el) {
  return comboboxOptionElements(el).map((o) => clean(o.textContent)).filter(Boolean);
}

function setNative(el, value) {
  // React and friends track the previous value on the DOM node, so a plain assignment gets ignored
  // on the next render. Going through the native setter makes the change stick.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Every element matching a CSS attribute selector, minus the sidebar's own controls. */
function allMatching(selector) {
  return [...document.querySelectorAll(selector)].filter((el) => !el.closest('#applygo-agent-root'));
}

/**
 * The one candidate that's actually usable when several elements could all plausibly answer to a
 * field's identity. Two real patterns collide here: a combobox trigger button typically has
 * neither name nor id of its own, so readForm() falls back to its aria-controls value (which is
 * also, by construction, the id of the element it controls -- resolving that string by id alone
 * would find the controlled dialog/listbox, not the button); and some combobox libraries pair a
 * visible styled control with a hidden native input carrying the real submitted value, matchable
 * only by a *different* attribute than the visible one (a real Greenhouse field had a hidden input
 * with name="country" alongside a visible combobox with id="country" and no name at all -- checking
 * name and id as separate sequential tiers, first-non-empty-wins, kept resolving to the hidden
 * input purely because its tier happened to be checked first). Pooling every candidate from every
 * lookup together and picking whichever one is actually visible handles both correctly regardless
 * of which specific attribute each element happened to match on.
 */
function preferVisible(matches) {
  return matches.find((el) => isVisible(el)) || matches[0] || null;
}

function findElement(name) {
  const escaped = CSS.escape(name);
  const candidates = [
    ...allMatching(`[name="${escaped}"], #${escaped}`),
    ...allMatching(`[aria-controls="${escaped}"]`),
  ];
  return candidates.length ? preferVisible(candidates) : null;
}

// Outline color is now decided entirely by verify_field's result (see markResult below), never by
// the fill attempt itself -- a fill that silently doesn't stick used to still get painted blue here,
// which is exactly the "ApplyGo thinks it's done but the form disagrees" state this exists to catch.
async function fillField(name, value) {
  const escaped = CSS.escape(name);
  const radios = [...document.querySelectorAll(`input[type="radio"][name="${escaped}"]`)];
  if (radios.length) {
    const hit = findOptionMatch(radios, value, (r) => labelFor(r) || r.value);
    if (!hit) return false;
    hit.click();
    return true;
  }

  const el = findElement(name);
  if (!el || !isVisible(el)) return false;

  if (el.tagName === 'SELECT') {
    const option = findOptionMatch([...el.options].filter(isRealOption), value, (o) => o.textContent);
    if (!option) return false;
    setSelectValue(el, option.value);
    return true;
  }

  if (isComboboxTrigger(el)) return fillCombobox(el, value);

  if (el.type === 'checkbox') {
    const group = synonymGroup(String(value).trim());
    const want = Boolean(group && (group.includes('yes') || group[0] === 'yes'));
    if (el.checked !== want) el.click();
    return true;
  }

  if (el.type === 'file') return false;

  setNative(el, value);
  return true;
}

/**
 * A native <select>'s value, set the way React-controlled forms need it to be -- the same "go
 * through the prototype's own setter" trick setNative() uses for text inputs, applied to
 * HTMLSelectElement. Assigning `.value` directly here was the actual bug behind dropdowns that
 * looked filled but the employer's form still treated as blank: React tracks the value it last set
 * on the node, a direct assignment doesn't update that tracker, and on the next render React (or the
 * library's own controlled-select logic) can silently revert the DOM back to what its own state says
 * the value should be -- which is still blank, since it never saw a real change happen.
 */
/**
 * Whether a selected option's visible text is what the candidate's answer actually meant --
 * verification has to accept the same synonym equivalences findOptionMatch used to make the
 * selection in the first place. Checking only a literal substring here is what let a selection
 * correctly made via a synonym ("usa" -> "United States") come back reported as failed: "united
 * states" does not contain the literal text "usa", even though the selection was exactly right.
 */
function textMatchesAnswer(actualText, want) {
  const a = String(actualText ?? '').trim().toLowerCase();
  const w = String(want ?? '').trim().toLowerCase();
  if (!a || !w) return false;
  if (a === w || a.includes(w)) return true;
  // Substring, not just exact match, because a control's rendered state often wraps the real value
  // in extra words a static equality check would miss entirely -- an aria-label reading "United
  // States selected" or "Selected: United States" is still evidence "usa" was accepted, since
  // "united states" (the matched synonym) appears in it either way.
  const group = synonymGroup(w);
  if (group && group.some((g) => a === g || a.includes(g))) return true;
  return a.includes(w.slice(0, 12));
}

function setSelectValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Selects the matching choice in a styled combobox by clicking it, the way a person actually would
 * -- setting the trigger's own text value directly leaves these libraries with a visible label that
 * doesn't match their real internal selection. Opens the control first if the option isn't already
 * in the DOM, and never leaves it open: a miss closes it again rather than abandoning the page in an
 * opened state.
 */
async function fillCombobox(el, value) {
  const findMatch = () => findOptionMatch(comboboxOptionElements(el), value, (o) => o.textContent);

  let match = findMatch();
  let openedByUs = false;
  if (!match) {
    el.click();
    openedByUs = true;
    // react-select and most similar libraries render the opened menu a tick after the click, not
    // synchronously inside it -- reading immediately is how an option that's genuinely there gets
    // missed.
    await new Promise((resolve) => setTimeout(resolve, 150));
    match = findMatch();
  }
  if (!match) {
    if (openedByUs) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return false;
  }
  match.click();
  return true;
}

/**
 * Options for a combobox whose listbox only mounts once opened -- react-select and most similar
 * libraries render the option list lazily, so a plain readForm() pass sees nothing until the
 * control has actually been clicked. Used only right before presenting one specific field to the
 * candidate (never during a background scan of the whole page, which would mean silently opening
 * and closing every dropdown on the form). Always closes the control again before returning,
 * whether or not anything was found, leaving the page exactly as it looked before this ran.
 */
async function discoverComboboxOptions(name) {
  const el = findElement(name);
  if (!el || !isVisible(el) || !isComboboxTrigger(el)) return [];
  const already = comboboxOptions(el);
  if (already.length) return already;

  el.click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const opened = comboboxOptions(el);
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  return opened;
}

/**
 * Did the value actually survive? A form can reject, reformat, or silently drop what was typed
 * (phone masks, date pickers, controlled React inputs that revert), and a fill that reports success
 * without checking is how a half-empty application gets called finished.
 */
function verifyField(name, expected) {
  const escaped = CSS.escape(name);
  const radios = [...document.querySelectorAll(`input[type="radio"][name="${escaped}"]`)];
  if (radios.length) {
    const checked = radios.find((r) => r.checked);
    if (!checked) return { ok: false, actual: '', reason: 'nothing_selected' };
    return { ok: true, actual: labelFor(checked) || checked.value };
  }

  const el = findElement(name);
  if (!el) return { ok: false, actual: '', reason: 'field_gone' };
  if (el.type === 'checkbox') return { ok: true, actual: el.checked ? 'checked' : 'unchecked' };
  if (el.type === 'file') return { ok: el.files && el.files.length > 0, actual: el.files?.[0]?.name || '' };

  if (isComboboxTrigger(el)) {
    // Many of these libraries never write the selection into the trigger's own .value -- the
    // selected label shows up as visible text instead, and not necessarily inside the nearest
    // narrowly-classed wrapper around the control: react-select routinely renders it as a sibling
    // of the input's container (e.g. a "select__single-value" div next to
    // "select__input-container"), which .textContent on just the input's own container would never
    // see. A button trigger that shows a flag/icon with no readable text (intl-tel-input's country
    // picker) instead reflects the choice only in its own updated aria-label, checked first.
    const ariaLabel = (el.getAttribute('aria-label') || '').trim();
    if (expected && textMatchesAnswer(ariaLabel, expected)) return { ok: true, actual: ariaLabel };
    for (const node of ancestors(el, 4)) {
      const text = clean(node.textContent);
      if (expected && textMatchesAnswer(text, expected)) return { ok: true, actual: text };
    }
    const inputValue = String(el.value ?? '').trim();
    if (inputValue) return { ok: true, actual: inputValue, rewritten: true };
    return { ok: false, actual: '', reason: 'option_not_selected' };
  }

  const actual = String(el.value ?? '').trim();
  if (!actual) return { ok: false, actual: '', reason: 'empty_after_fill' };

  const want = String(expected ?? '').trim();
  if (el.tagName === 'SELECT') {
    const text = (el.selectedOptions[0]?.textContent || '').trim();
    const matched = Boolean(text) && textMatchesAnswer(text, want);
    return matched ? { ok: true, actual: text } : { ok: false, actual: text, reason: 'option_not_selected' };
  }
  // Reformatting is expected and fine -- a phone mask turning 5551234567 into (555) 123-4567 kept
  // the answer. The failure this is really guarding against is a controlled input silently
  // reverting to empty, which `empty_after_fill` above already caught; anything else non-empty
  // counts as accepted, but a value that no longer resembles what was typed is flagged so the
  // final review can put a human eye on it rather than calling it done.
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = normalize(actual);
  const b = normalize(want);
  if (a === b || a.includes(b) || b.includes(a)) return { ok: true, actual };
  return { ok: true, actual, rewritten: true };
}

function mark(el, outline) {
  el.style.outline = outline;
  el.style.outlineOffset = '2px';
}

/** Finds by name or, for a radio group, by any member -- the one lookup every mark/scroll call needs. */
function findAny(name) {
  return findElement(name) || document.querySelector(`input[type="radio"][name="${CSS.escape(name)}"]`);
}

function scrollToField(name) {
  const el = findAny(name);
  if (!el) return false;
  fieldContainer(el).scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

/** A brighter outline for the one field the agent is working on right now. */
function highlightField(name, on) {
  const el = findAny(name);
  if (!el) return false;
  const target = fieldContainer(el);
  if (on) mark(target, ACTIVE_OUTLINE);
  else {
    target.style.outline = '';
    target.style.outlineOffset = '';
  }
  return true;
}

function markMissing(name) {
  const el = findAny(name);
  if (el) mark(fieldContainer(el), MISSING_OUTLINE);
}

/**
 * The one place a field's outline turns green or red -- called by the agent right after
 * verify_field, never by the fill functions themselves, so the color always reflects what verify_field
 * actually found rather than what the fill attempt merely hoped for.
 */
function markResult(name, ok) {
  const el = findAny(name);
  if (!el) return false;
  mark(fieldContainer(el), ok ? VERIFIED_OUTLINE : FAILED_OUTLINE);
  return true;
}

/** The visible file input on the employer's form -- the one thing attach and verify both need. */
function resumeFileInput() {
  return [...document.querySelectorAll('input[type="file"]')].find(
    (el) => isVisible(el) && !el.closest('#applygo-agent-root'),
  );
}

/** Attaches the resume PDF to a file input, which needs a real File on a DataTransfer. */
function attachResumeFromBase64(base64, filename) {
  const input = resumeFileInput();
  if (!input) return { ok: false, reason: 'no_file_input' };
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], filename || 'resume.pdf', { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  mark(input, ACTIVE_OUTLINE);
  return { ok: true, name: input.name || input.id || 'resume' };
}

/**
 * Did the resume actually land in the employer's control, and is it genuinely the file ApplyGo
 * meant to attach? Constructing a File object and setting `.files` can silently be rejected by some
 * frameworks the same way a plain input assignment can, so this reads the input back rather than
 * assuming the DataTransfer trick worked -- "selected" (a File object exists), "attached" (it's on
 * the input), and "verified" (this check passed) are three different claims, and only the last one
 * should ever be shown to the candidate as done.
 */
function verifyResumeAttached(expectedFilename) {
  const input = resumeFileInput();
  if (!input) return { ok: false, reason: 'no_file_input' };
  const file = input.files && input.files[0];
  if (!file) return { ok: false, reason: 'empty_after_attach' };
  if (expectedFilename && file.name !== expectedFilename) return { ok: false, actual: file.name, reason: 'unexpected_file' };
  return { ok: true, actual: file.name };
}

/** The cover letter goes into whichever textarea is asking for one, when there is such a field. */
function fillCoverLetter(text) {
  const target = [...document.querySelectorAll('textarea')].find(
    (t) => isVisible(t) && !t.closest('#applygo-agent-root') && /cover|letter|why|introduc|tell us/i.test(labelFor(t)),
  );
  if (!target) return { ok: false, reason: 'no_cover_letter_field' };
  if (String(target.value || '').trim()) return { ok: false, reason: 'already_filled' };
  setNative(target, text);
  mark(target, VERIFIED_OUTLINE);
  return { ok: true, name: target.name || target.id || '' };
}

/**
 * Validation messages the employer's own form is showing. Both channels count: the browser's
 * constraint API (checkValidity) and whatever the page rendered itself, since most ATS forms do
 * their own validation and never set the native flag.
 */
function readValidationErrors() {
  const errors = [];
  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (!isVisible(el) || el.closest('#applygo-agent-root')) return;
    if (typeof el.checkValidity === 'function' && !el.checkValidity()) {
      errors.push({ name: el.name || el.id || '', message: el.validationMessage || 'invalid', source: 'native' });
    }
  });
  document.querySelectorAll('[aria-invalid="true"], .error, [class*="error"]').forEach((node) => {
    if (node.closest('#applygo-agent-root')) return;
    const text = clean(node.textContent);
    // Class-name matches catch a lot of empty wrappers; only a node that actually says something
    // short and human is worth reporting as an error.
    if (!text || text.length > 160) return;
    const control = node.querySelector('input,select,textarea');
    errors.push({ name: control?.name || control?.id || '', message: text, source: 'page' });
  });
  return errors.slice(0, 25);
}

// ---------------------------------------------------------------------------
// The action surface the agent is allowed to use. Anything not here, it cannot do.
// ---------------------------------------------------------------------------
window.ApplyGoDom = {
  readForm,
  labelFor,
  isVisible,
  fillField,
  verifyField,
  scrollToField,
  highlightField,
  markMissing,
  markResult,
  attachResumeFromBase64,
  verifyResumeAttached,
  fillCoverLetter,
  discoverComboboxOptions,
  readValidationErrors,
  pageUrl: () => location.href,
};

// The toolbar popup's only job on an application page: force the assistant open. Useful when the
// page didn't look like an application to the detection heuristic, or the tab was collapsed and the
// candidate would rather click the icon than hunt for the edge tab.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OPEN_SIDEBAR') {
    if (window.ApplyGoSidebar) {
      window.ApplyGoSidebar.openManually();
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'not_an_application_page' });
    }
    return true;
  }
  return false;
});
