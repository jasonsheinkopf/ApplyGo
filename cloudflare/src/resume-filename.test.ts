import assert from "node:assert/strict";
import test from "node:test";

import { resumeFilenameFor, sanitizeForFilename } from "./resume-filename.ts";

test("resumeFilenameFor: normal case is FirstName_LastName_Company.pdf", () => {
  assert.equal(resumeFilenameFor("Jason Sheinkopf", "Anthropic"), "Jason_Sheinkopf_Anthropic.pdf");
});

test("resumeFilenameFor: falls back to _Resume.pdf with no company", () => {
  assert.equal(resumeFilenameFor("Jason Sheinkopf", ""), "Jason_Sheinkopf_Resume.pdf");
});

test("resumeFilenameFor: falls back to Candidate with no name", () => {
  assert.equal(resumeFilenameFor("", "Anthropic"), "Candidate_Anthropic.pdf");
});

test("resumeFilenameFor: middle names/suffixes fold into the last-name part", () => {
  assert.equal(resumeFilenameFor("Mary Jane Watson", "Acme"), "Mary_Jane_Watson_Acme.pdf");
});

test("resumeFilenameFor: never leaks spaces or path separators", () => {
  const name = resumeFilenameFor("Jason Sheinkopf", "Big & Co / Space Inc.");
  assert.doesNotMatch(name, /[\s/\\]/);
  assert.match(name, /^Jason_Sheinkopf_[A-Za-z0-9_]+\.pdf$/);
});

test("sanitizeForFilename: strips accents rather than dropping the character", () => {
  assert.equal(sanitizeForFilename("José"), "Jose");
});

test("sanitizeForFilename: collapses punctuation/whitespace runs into single underscores", () => {
  assert.equal(sanitizeForFilename("O'Brien & Sons, Inc."), "O_Brien_Sons_Inc");
});

test("sanitizeForFilename: never exposes a raw UUID-shaped internal id unexpectedly untouched", () => {
  // Not a claim that ids are ever passed in -- a regression guard that the sanitizer still only
  // ever emits filename-safe characters no matter what string it's given.
  const out = sanitizeForFilename("../../etc/passwd\0");
  assert.doesNotMatch(out, /[./\\\0]/);
});
