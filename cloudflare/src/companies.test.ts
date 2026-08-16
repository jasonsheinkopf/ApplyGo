import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyVerification,
  type CompanySearchTerm,
  companySearchTermsFromTitles,
  mergeCompanySearchTerms,
  resolveCompanyDomain,
  titleCaseTerm,
} from "./companies.ts";

test("resolveCompanyDomain returns the first guessed candidate that verifies", async () => {
  const previous = globalThis.fetch;
  const tried: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    tried.push(url);
    // "Acme Robotics" -> slugsFromName produces ["acmerobotics", "acme-robotics"]; only the third
    // guess tried (acmerobotics.io, after acmerobotics.com and acme-robotics.com) resolves.
    if (url === "https://acmerobotics.io") return new Response("", { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    const domain = await resolveCompanyDomain("Acme Robotics");
    assert.equal(domain, "https://acmerobotics.io");
    assert.deepEqual(tried, ["https://acmerobotics.com", "https://acmerobotics.io"], "must stop at the first hit, not try every candidate");
  } finally {
    globalThis.fetch = previous;
  }
});

test("resolveCompanyDomain returns null when nothing verifies, never inventing a domain", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
  try {
    assert.equal(await resolveCompanyDomain("Totally Fictional Startup"), null);
  } finally {
    globalThis.fetch = previous;
  }
});

test("classifyVerification: no website at all is unverified/no_website, regardless of anything else", () => {
  assert.deepEqual(classifyVerification(false, null, false, false), { status: "unverified", verify_reason: "no_website" });
  assert.deepEqual(classifyVerification(false, { provider: "greenhouse", token: "acme" }, false, true), {
    status: "unverified",
    verify_reason: "no_website",
  });
});

test("classifyVerification: a website with no board resolution at all is unverified/no_job_board", () => {
  assert.deepEqual(classifyVerification(true, null, false, false), { status: "unverified", verify_reason: "no_job_board" });
});

test("classifyVerification: a resolved but unreadable ATS is unverified/unsupported_ats", () => {
  assert.deepEqual(classifyVerification(true, { provider: "adp", token: "workforcenow.adp.com/acme" }, false, false), {
    status: "unverified",
    verify_reason: "unsupported_ats",
  });
});

test("classifyVerification: a readable board that resolves and reads successfully is verified", () => {
  assert.deepEqual(classifyVerification(true, { provider: "greenhouse", token: "acme" }, false, false), {
    status: "verified",
    verify_reason: "",
  });
});

test("classifyVerification: a first-ever read failure on a readable board is unverified/board_unreachable", () => {
  assert.deepEqual(classifyVerification(true, { provider: "greenhouse", token: "acme" }, true, false), {
    status: "unverified",
    verify_reason: "board_unreachable",
  });
});

test("classifyVerification: a read failure is never a demotion once a company has read successfully before", () => {
  // The whole reason hadPriorSuccess exists: a company that has worked before shouldn't flip to
  // Unverified just because one later scan hit a transient network blip.
  assert.deepEqual(classifyVerification(true, { provider: "greenhouse", token: "acme" }, true, true), {
    status: "verified",
    verify_reason: "",
  });
});

test("titleCaseTerm capitalizes the first letter of each word, leaving the rest as-is", () => {
  assert.equal(titleCaseTerm("machine learning engineer"), "Machine Learning Engineer");
  assert.equal(titleCaseTerm("ai/ml engineer"), "Ai/Ml Engineer");
});

test("companySearchTermsFromTitles caps at 15, title-cases, and tags every term generated", () => {
  const titles = Array.from({ length: 20 }, (_, i) => `role title ${i}`);
  const terms = companySearchTermsFromTitles(titles);
  assert.equal(terms.length, 15, "must cap at MAX_GENERATED_SEARCH_TERMS even with more titles available");
  assert.equal(terms[0].term, "Role Title 0");
  assert.ok(terms.every((t) => t.source === "generated"));
});

test("companySearchTermsFromTitles returns [] for no titles, never inventing a term", () => {
  assert.deepEqual(companySearchTermsFromTitles([]), []);
});

test("mergeCompanySearchTerms keeps every manual term untouched and orders it first", () => {
  const manual: CompanySearchTerm[] = [{ term: "Vehicle Motion Personalization Engineer", source: "manual" }];
  const generated: CompanySearchTerm[] = [{ term: "AI Engineer", source: "generated" }];
  const merged = mergeCompanySearchTerms(manual, generated);
  assert.deepEqual(merged, [
    { term: "Vehicle Motion Personalization Engineer", source: "manual" },
    { term: "AI Engineer", source: "generated" },
  ]);
});

test("mergeCompanySearchTerms drops a generated term that case-insensitively duplicates a manual one", () => {
  const manual: CompanySearchTerm[] = [{ term: "AI Engineer", source: "manual" }];
  const generated: CompanySearchTerm[] = [{ term: "ai engineer", source: "generated" }, { term: "ML Engineer", source: "generated" }];
  const merged = mergeCompanySearchTerms(manual, generated);
  assert.deepEqual(merged, [
    { term: "AI Engineer", source: "manual" },
    { term: "ML Engineer", source: "generated" },
  ]);
});
