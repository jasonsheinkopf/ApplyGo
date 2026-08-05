// Reads whatever application form is actually on the page, and fills it.
//
// Reading the live DOM rather than an ATS API is the whole reason this is an extension: it works on
// any form, including ones ApplyGo has never seen, and it sees exactly what the candidate sees. The
// tradeoff is that selectors have to be generic, so everything below keys off structure and labels
// rather than per-vendor class names.
//
// This script never submits. It fills, highlights what it touched, and stops.

const FILLED_OUTLINE = '2px solid #4f46e5';
const MISSING_OUTLINE = '2px dashed #d97706';

/** The visible question for a control, tried in the order that actually works most often. */
function labelFor(el) {
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

  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (!isVisible(el)) return;
    if (['submit', 'button', 'reset', 'search'].includes(el.type)) return;

    const name = el.name || el.id;
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
      });
      return;
    }

    fields.push({
      name,
      label: labelFor(el),
      type: el.type === 'file' ? 'file' : el.tagName === 'TEXTAREA' ? 'textarea' : el.type || 'text',
      required: el.required,
      options: [],
    });
  });

  return fields.filter((f) => f.label);
}

/**
 * Drops the leading "Please select" style placeholder so it never gets offered as a real answer.
 * Checks both conventions: a blank value attribute (how well-authored forms mark it) and the
 * handful of placeholder phrasings that show up when the value is just the label text.
 */
function isRealOption(option) {
  const text = option.textContent.trim();
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

function fillField(name, value) {
  const escaped = CSS.escape(name);
  const radios = [...document.querySelectorAll(`input[type="radio"][name="${escaped}"]`)];
  if (radios.length) {
    const want = String(value).trim().toLowerCase();
    const hit = radios.find((r) => (labelFor(r) || r.value).trim().toLowerCase() === want)
      || radios.find((r) => (labelFor(r) || r.value).trim().toLowerCase().startsWith(want));
    if (!hit) return false;
    hit.click();
    mark(hit.closest('label,div') || hit, FILLED_OUTLINE);
    return true;
  }

  const el = document.querySelector(`[name="${escaped}"]`) || document.getElementById(name);
  if (!el || !isVisible(el)) return false;

  if (el.tagName === 'SELECT') {
    const want = String(value).trim().toLowerCase();
    const option = [...el.options].find((o) => o.textContent.trim().toLowerCase() === want)
      || [...el.options].find((o) => o.textContent.trim().toLowerCase().includes(want));
    if (!option) return false;
    el.value = option.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    mark(el, FILLED_OUTLINE);
    return true;
  }

  if (el.type === 'checkbox') {
    const want = /^(yes|true|1|on|i agree|agree)$/i.test(String(value).trim());
    if (el.checked !== want) el.click();
    mark(el, FILLED_OUTLINE);
    return true;
  }

  if (el.type === 'file') return false;

  setNative(el, value);
  mark(el, FILLED_OUTLINE);
  return true;
}

function mark(el, outline) {
  el.style.outline = outline;
  el.style.outlineOffset = '2px';
}

/** Attaches the resume PDF to a file input, which needs a real File on a DataTransfer. */
async function attachResume(fileUrl, apiBase, token) {
  const input = [...document.querySelectorAll('input[type="file"]')].find(isVisible);
  if (!input) return false;
  const res = await fetch(apiBase + fileUrl, { headers: { authorization: 'Bearer ' + token } });
  if (!res.ok) return false;
  const blob = await res.blob();
  const file = new File([blob], 'resume.pdf', { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  mark(input, FILLED_OUTLINE);
  return true;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'READ_FORM') {
    sendResponse({ fields: readForm(), url: location.href });
    return true;
  }

  if (msg.type === 'FILL') {
    (async () => {
      let filled = 0;
      for (const answer of msg.answers || []) {
        if (fillField(answer.name, answer.value)) filled += 1;
      }

      // The cover letter goes into whichever textarea is asking for one, when there is such a field.
      if (msg.coverLetterText) {
        const target = [...document.querySelectorAll('textarea')].find(
          (t) => isVisible(t) && /cover|letter|why|introduc/i.test(labelFor(t)),
        );
        if (target && !target.value.trim()) {
          setNative(target, msg.coverLetterText);
          filled += 1;
        }
      }

      let resumeAttached = false;
      if (msg.resumeUrl) {
        try {
          resumeAttached = await attachResume(msg.resumeUrl, msg.apiBase, msg.token);
        } catch {
          resumeAttached = false;
        }
      }

      // Flag what was left blank so nothing is silently skipped on the way to submitting.
      for (const field of msg.missing || []) {
        const el = document.querySelector(`[name="${CSS.escape(field.name)}"]`) || document.getElementById(field.name);
        if (el) mark(el, MISSING_OUTLINE);
      }

      sendResponse({ filled, resumeAttached });
    })();
    return true;
  }

  return false;
});
