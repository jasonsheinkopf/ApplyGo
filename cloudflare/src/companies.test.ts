import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyVerification,
  type CompanySearchTerm,
  companySearchTermsFromTitles,
  fetchBoardJobs,
  fetchMissingDescriptions,
  isReadableAtsProvider,
  mergeCompanySearchTerms,
  resolveCompanyDomain,
  titleCaseTerm,
} from "./companies.ts";

function mockJson(routes: Record<string, unknown>) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input).split("?")[0];
    const body = routes[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return Response.json(body);
  }) as typeof fetch;
}

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

// ---------------------------------------------------------------------------
// Workable / Recruitee / BambooHR -- added after investigating all 13 previously detect-only
// providers and confirming these three have a real, live, unauthenticated JSON API (9 real
// companies checked, 3 per provider). Fixtures below are trimmed shapes of the actual live
// responses captured during that investigation, not invented.
// ---------------------------------------------------------------------------

test("isReadableAtsProvider now includes workable, recruitee, and bamboohr", () => {
  for (const p of ["workable", "recruitee", "bamboohr"] as const) assert.equal(isReadableAtsProvider(p), true);
  // Every other detect-only provider must still be excluded -- this addition must not have
  // widened the set by accident.
  for (const p of ["adp", "icims", "jazzhr", "breezy", "personio", "paylocity", "ukg", "successfactors", "taleo", "jobvite"] as const) {
    assert.equal(isReadableAtsProvider(p), false, p);
  }
});

test("fetchBoardJobs parses a real Workable widget response, description included inline", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockJson({
    "https://apply.workable.com/api/v1/widget/accounts/flosum": {
      name: "Flosum",
      description: null,
      jobs: [{
        title: "Account Executive - Enterprise - US", shortcode: "81F531F5F0", employment_type: "Full-time",
        department: "Sales", url: "https://apply.workable.com/j/81F531F5F0",
        shortlink: "https://apply.workable.com/j/81F531F5F0",
        published_on: "2025-10-23", created_at: "2025-10-02",
        country: "United States", city: "San Ramon", state: "California",
        locations: [{ country: "United States", city: "San Ramon", region: "California" }],
        description: "<p>A bit About Flosum</p>",
      }],
    },
  });
  try {
    const jobs = await fetchBoardJobs("workable", "flosum");
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0], {
      external_id: "81F531F5F0",
      title: "Account Executive - Enterprise - US",
      url: "https://apply.workable.com/j/81F531F5F0",
      location: "San Ramon, California, United States",
      posted_at: "2025-10-23",
      description: "A bit About Flosum",
    });
  } finally {
    globalThis.fetch = previous;
  }
});

test("fetchBoardJobs falls back to a job's own locations[0] when top-level city/state/country are blank", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockJson({
    "https://apply.workable.com/api/v1/widget/accounts/acme": {
      jobs: [{
        title: "Remote Engineer", shortcode: "ABC123", url: "https://apply.workable.com/j/ABC123",
        locations: [{ city: "Berlin", region: "", country: "Germany" }], description: "",
      }],
    },
  });
  try {
    const jobs = await fetchBoardJobs("workable", "acme");
    assert.equal(jobs[0].location, "Berlin, Germany");
  } finally {
    globalThis.fetch = previous;
  }
});

test("fetchBoardJobs parses a real Recruitee offers response, description included inline", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockJson({
    "https://fastned.recruitee.com/api/offers/": {
      // id is a real JSON number in Recruitee's live API (confirmed), not a string -- this fixture
      // deliberately keeps it numeric so a regression back to a bare str(j.id) gets caught again.
      offers: [{
        id: 2707770, guid: "yrrua", title: "Senior Expansion Manager - Denmark",
        location: "Copenhagen, Hovedstaden, Denmark",
        careers_apply_url: "https://fastned.recruitee.com/o/senior-expansion-manager-denmark/c/new",
        careers_url: "https://fastned.recruitee.com/o/senior-expansion-manager-denmark",
        published_at: "2026-08-12 09:02:05 UTC", created_at: "2026-08-01 00:00:00 UTC",
        description: "<p>Become part of a fast-growing company</p>",
      }],
    },
  });
  try {
    const jobs = await fetchBoardJobs("recruitee", "fastned");
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0], {
      external_id: "2707770",
      title: "Senior Expansion Manager - Denmark",
      url: "https://fastned.recruitee.com/o/senior-expansion-manager-denmark/c/new",
      location: "Copenhagen, Hovedstaden, Denmark",
      posted_at: "2026-08-12 09:02:05 UTC",
      description: "Become part of a fast-growing company",
    });
  } finally {
    globalThis.fetch = previous;
  }
});

test("fetchBoardJobs coerces Recruitee's numeric id rather than silently falling through to guid", async () => {
  // Regression test: str() only accepts strings, so `str(j.id) || str(j.guid)` looked like it
  // preferred id but, since id is always a JSON number in the real API, silently used guid on
  // every single job. Not wrong data, but not what the code claimed to do -- caught by comparing
  // against a real captured response rather than a hand-written fixture.
  const previous = globalThis.fetch;
  globalThis.fetch = mockJson({
    "https://acme.recruitee.com/api/offers/": { offers: [{ id: 999, guid: "zzz", title: "x", description: "" }] },
  });
  try {
    const jobs = await fetchBoardJobs("recruitee", "acme");
    assert.equal(jobs[0].external_id, "999");
  } finally {
    globalThis.fetch = previous;
  }
});

test("fetchBoardJobs reads BambooHR's thin list -- id, title, and location only, everything else blank", async () => {
  // The real /careers/list response has no description, url, or date at all -- confirmed live,
  // not assumed. Those three fields have to come from the per-posting detail endpoint instead.
  const previous = globalThis.fetch;
  globalThis.fetch = mockJson({
    "https://prentkeromich.bamboohr.com/careers/list": {
      meta: { totalCount: 1 },
      result: [{
        id: "474", jobOpeningName: "Shipping Clerk- Internal Only ", departmentId: "18923",
        departmentLabel: "Shipping", employmentStatusLabel: "Full Time",
        location: { city: "Wooster", state: "Ohio", postalCode: "44691", addressCountry: "United States" },
      }],
    },
  });
  try {
    const jobs = await fetchBoardJobs("bamboohr", "prentkeromich");
    assert.deepEqual(jobs, [{
      external_id: "474",
      title: "Shipping Clerk- Internal Only ",
      url: "",
      location: "Wooster, Ohio, United States",
      posted_at: "",
      description: "",
    }]);
  } finally {
    globalThis.fetch = previous;
  }
});

test("fetchMissingDescriptions fills BambooHR's url and description from the real detail endpoint shape", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockJson({
    "https://prentkeromich.bamboohr.com/careers/474/detail": {
      meta: {},
      result: {
        jobOpening: {
          jobOpeningShareUrl: "https://prentkeromich.bamboohr.com/careers/474",
          jobOpeningName: "Shipping Clerk- Internal Only ",
          description: "<p>Keep Operations Moving</p>",
        },
      },
    },
  });
  const jobs = [{ external_id: "474", title: "Shipping Clerk", url: "", location: "Wooster, Ohio", posted_at: "", description: "" }];
  try {
    await fetchMissingDescriptions("bamboohr", "prentkeromich", jobs, { remaining: 50 });
    assert.equal(jobs[0].url, "https://prentkeromich.bamboohr.com/careers/474");
    assert.equal(jobs[0].description, "Keep Operations Moving");
  } finally {
    globalThis.fetch = previous;
  }
});

test("fetchMissingDescriptions leaves a BambooHR posting untouched if the detail fetch fails", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
  const jobs = [{ external_id: "474", title: "Shipping Clerk", url: "", location: "", posted_at: "", description: "" }];
  try {
    await fetchMissingDescriptions("bamboohr", "prentkeromich", jobs, { remaining: 50 });
    assert.equal(jobs[0].description, "", "a failed detail fetch must never throw or crash the scan");
    assert.equal(jobs[0].url, "");
  } finally {
    globalThis.fetch = previous;
  }
});

test("fetchMissingDescriptions is still a no-op for providers whose listing already includes a description", async () => {
  const previous = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("", { status: 200 }); }) as typeof fetch;
  const jobs = [{ external_id: "1", title: "x", url: "", location: "", posted_at: "", description: "already here" }];
  try {
    await fetchMissingDescriptions("workable", "acme", jobs, { remaining: 50 });
    await fetchMissingDescriptions("recruitee", "acme", jobs, { remaining: 50 });
    assert.equal(called, false, "workable/recruitee jobs already have descriptions inline; no detail fetch should ever fire");
  } finally {
    globalThis.fetch = previous;
  }
});

test("fetchBoardJobs (Workday) stops paginating once the shared budget runs out", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    // Every page reports a full page and a huge total, so the loop would otherwise keep paging
    // all the way to MAX_WORKDAY_PAGES (10) on its own.
    return Response.json({
      total: 500,
      jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: `Job ${i}`, externalPath: `/job/${i}`, locationsText: "" })),
    });
  }) as typeof fetch;
  try {
    // Page 0 is priced by the caller (scanOneCompany's own `budget.remaining -= 1` before calling
    // fetchBoardJobs, not exercised here), so fetchWorkdayJobs itself only meters pages 1+ -- a
    // budget of 2 must cap it at 3 total real fetches (page 0, plus 2 more).
    const budget = { remaining: 2 };
    const jobs = await fetchBoardJobs("workday", "tenant|pod|site", budget);
    assert.equal(calls, 3, "must not spend more real fetches paginating than the shared budget allows");
    assert.equal(budget.remaining, 0);
    assert.equal(jobs.length, 60, "3 pages of 20 postings each");
  } finally {
    globalThis.fetch = previous;
  }
});

test("fetchBoardJobs (Workday) with no budget argument paginates fully, exactly as before", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({
      total: 25,
      jobPostings: calls === 1
        ? Array.from({ length: 20 }, (_, i) => ({ title: `Job ${i}`, externalPath: `/job/${i}`, locationsText: "" }))
        : Array.from({ length: 5 }, (_, i) => ({ title: `Job ${20 + i}`, externalPath: `/job/${20 + i}`, locationsText: "" })),
    });
  }) as typeof fetch;
  try {
    const jobs = await fetchBoardJobs("workday", "tenant|pod|site");
    assert.equal(calls, 2);
    assert.equal(jobs.length, 25);
  } finally {
    globalThis.fetch = previous;
  }
});
