// Loads content.js into a real (jsdom) DOM so its DOM-reading/writing functions can be exercised
// against constructed fixtures -- a native <select>, a radio group, an ARIA combobox -- rather than
// re-implementing or guessing at their behavior in the test itself.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

export function loadContentJs(bodyHtml = '') {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: 'https://job-boards.greenhouse.io/testco/jobs/1',
    runScripts: 'dangerously',
  });
  const { window } = dom;
  // content.js's bottom-of-file listener registration needs this to exist before the script runs;
  // the extension's real background.js is not part of what's under test here.
  window.chrome = { runtime: { onMessage: { addListener() {} } } };
  // jsdom has no layout engine, so every element's getClientRects() is empty by default -- that
  // reads as "invisible" to content.js's isVisible() check and would make every fixture silently
  // filtered out. A fixed non-empty rect is the standard jsdom workaround for testing anything that
  // gates on visibility, and nothing under test here actually depends on real geometry.
  window.Element.prototype.getClientRects = function () {
    return [{ width: 10, height: 10, top: 0, left: 0, bottom: 10, right: 10 }];
  };
  const src = fs.readFileSync(path.join(DIR, 'content.js'), 'utf8');
  window.eval(src);
  return { dom, window, document: window.document, ApplyGoDom: window.ApplyGoDom };
}
