import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanCompanyName,
  companyIdentity,
  companyMatchKey,
  domainCandidates,
  isNonCompanyName,
  isSameCompany,
} from "./identity.ts";

// Every raw name in this file is a real string taken from the local companies table, chosen
// because it was actually failing. They are regression data, not invented examples.

test("cleanCompanyName strips trailing legal suffixes, including punctuated and stacked ones", () => {
  assert.equal(cleanCompanyName("DocuSign Inc"), "DocuSign");
  assert.equal(cleanCompanyName("Sargent & Lundy LLC."), "Sargent & Lundy");
  assert.equal(cleanCompanyName("Voyager Technologies, Inc."), "Voyager Technologies");
  assert.equal(cleanCompanyName("Capital Group Companies Inc."), "Capital Group Companies");
  assert.equal(cleanCompanyName("Green Dot Corporation"), "Green Dot");
  assert.equal(cleanCompanyName("Financial Advocates INC"), "Financial Advocates");
});

test("cleanCompanyName preserves the employer's own capitalization and ampersands", () => {
  // The display name is what a human reads -- lowercasing it here was a real defect.
  assert.equal(cleanCompanyName("Russell, Tobin & Associates"), "Russell, Tobin & Associates");
  assert.equal(cleanCompanyName("SAMYANG AMERICA"), "SAMYANG AMERICA");
  assert.equal(cleanCompanyName("TP-Link Systems Inc."), "TP-Link Systems");
});

test("cleanCompanyName removes source-system artifacts, not the employer name attached to them", () => {
  assert.equal(cleanCompanyName("CorVel Career Site"), "CorVel");
  assert.equal(cleanCompanyName("6010-Biosense Webster Legal Entity"), "Biosense Webster");
  assert.equal(cleanCompanyName("JBC powered by Workgenius"), "JBC");
});

test("cleanCompanyName never strips a suffix word that is the whole name", () => {
  // "Limited" alone is meaningless but dropping it would leave an empty company.
  assert.equal(cleanCompanyName("Limited"), "Limited");
  assert.equal(cleanCompanyName("Co"), "Co");
});

test("cleanCompanyName leaves a mid-name suffix word alone", () => {
  // Only the *trailing* token is a legal suffix. "Company" here is part of the real name.
  assert.equal(cleanCompanyName("Bain & Company Consulting"), "Bain & Company Consulting");
  assert.equal(cleanCompanyName("3M"), "3M");
  assert.equal(cleanCompanyName("7-Eleven"), "7-Eleven");
});

test("isNonCompanyName flags pure ATS page titles and keeps real companies", () => {
  assert.equal(isNonCompanyName("Careers Listing"), true);
  assert.equal(isNonCompanyName("Job Board"), true);
  assert.equal(isNonCompanyName(""), true);
  assert.equal(isNonCompanyName("CorVel Career Site"), false, "a real employer wrapped in an artifact must survive");
  assert.equal(isNonCompanyName("Ingram Micro"), false);
});

test("companyMatchKey merges legal-suffix and punctuation variants of one employer", () => {
  assert.equal(companyMatchKey("Sargent & Lundy LLC."), companyMatchKey("Sargent and Lundy"));
  assert.equal(companyMatchKey("DocuSign Inc"), companyMatchKey("DocuSign, Inc."));
  assert.equal(companyMatchKey("Voyager Technologies, Inc."), companyMatchKey("Voyager Technologies"));
});

test("companyMatchKey merges the real 'Sargent & Lundy' duplicate pair from the database", () => {
  // Both rows exist today as separate companies. An ampersand written one way by one source and
  // omitted by another is not a different employer.
  assert.equal(companyMatchKey("Sargent & Lundy LLC."), companyMatchKey("Sargent Lundy"));
  assert.equal(companyMatchKey("Bausch & Lomb"), companyMatchKey("Bausch and Lomb"));
});

test("companyMatchKey does NOT merge employers distinguished only by a descriptive word", () => {
  // The old companyNameKey stripped "group"/"technologies"/"labs" and silently merged these.
  // A false merge destroys a real company's pipeline, so it must not happen on a string alone.
  assert.notEqual(companyMatchKey("Meta Platforms"), companyMatchKey("Meta Materials"));
  assert.notEqual(companyMatchKey("Black Rock Groups"), companyMatchKey("Black Rock"));
  assert.notEqual(companyMatchKey("Indus River Technologies"), companyMatchKey("Indus River"));
});

test("isSameCompany requires an exact key match and never matches an empty name", () => {
  assert.equal(isSameCompany("Acme, Inc.", "ACME"), true);
  assert.equal(isSameCompany("Acme Robotics", "Acme Systems"), false);
  assert.equal(isSameCompany("", ""), false, "two empty names are not 'the same company'");
});

test("companyIdentity keeps the source name intact alongside the cleaned display name", () => {
  const id = companyIdentity("6010-Biosense Webster Legal Entity");
  assert.equal(id.sourceName, "6010-Biosense Webster Legal Entity");
  assert.equal(id.displayName, "Biosense Webster");
  assert.equal(id.matchKey, "biosense webster");
});

test("companyIdentity falls back to the raw text rather than displaying an empty company", () => {
  const id = companyIdentity("Careers Listing");
  assert.equal(id.displayName, "Careers Listing");
});

test("domainCandidates drops legal suffixes -- the single biggest cause of the no_website backlog", () => {
  // The old slugsFromName produced only "docusigninc", so docusign.com was never even tried.
  assert.ok(domainCandidates("DocuSign Inc").includes("docusign"));
  assert.ok(domainCandidates("Financial Advocates INC").includes("financialadvocates"));
});

test("domainCandidates progressively drops generic trailing words", () => {
  assert.ok(domainCandidates("Green Dot Corporation").includes("greendot"));
  assert.ok(domainCandidates("SHI International Corporation").includes("shi"));
  assert.ok(domainCandidates("Harman International").includes("harman"));
  assert.ok(domainCandidates("Capital Group Companies Inc.").includes("capitalgroup"));
});

test("domainCandidates handles an ampersand by trying the part before it", () => {
  assert.ok(domainCandidates("Bausch & Lomb").includes("bausch"));
});

test("domainCandidates offers an initialism for long multi-word names", () => {
  // uci.edu -- and .edu is in DOMAIN_TLDS specifically because universities were systematically missed.
  assert.ok(domainCandidates("University of California, Irvine").includes("uci"));
});

test("domainCandidates orders the full name first, so an exact domain wins over a shortened guess", () => {
  const candidates = domainCandidates("Ingram Micro");
  assert.equal(candidates[0], "ingrammicro");
});

test("domainCandidates returns [] for a name with no usable content", () => {
  assert.deepEqual(domainCandidates("Careers Listing"), []);
  assert.deepEqual(domainCandidates(""), []);
});

test("domainCandidates never emits an invalid DNS label", () => {
  for (const raw of ["Russell, Tobin & Associates", "TP-Link Systems Inc.", "University of California, Irvine", "3M"]) {
    for (const candidate of domainCandidates(raw)) {
      assert.match(candidate, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, `${raw} produced invalid label ${candidate}`);
      assert.ok(candidate.length <= 63);
    }
  }
});
