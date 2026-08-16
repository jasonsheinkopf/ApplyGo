import assert from "node:assert/strict";
import test from "node:test";

import { aggregateCompanies, adzunaConfigured, searchAdzunaPage, type AdzunaPosting } from "./adzuna.ts";

const ENV = { ADZUNA_APP_ID: "id123", ADZUNA_APP_KEY: "key456", ADZUNA_COUNTRY: "us" };

const posting = (overrides: Partial<AdzunaPosting> = {}): AdzunaPosting => ({
  id: "", title: "", company: "", location: "", category: "", created: "", url: "", ...overrides,
});

test("adzunaConfigured requires both credentials", () => {
  assert.equal(adzunaConfigured(ENV), true);
  assert.equal(adzunaConfigured({ ADZUNA_APP_ID: "id123" }), false);
  assert.equal(adzunaConfigured({}), false);
});

test("searchAdzunaPage builds the expected request and parses structured results", async () => {
  const previous = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return Response.json({
      count: 1,
      results: [
        {
          id: "12345",
          title: "Software Engineer",
          company: { display_name: "Acme Inc" },
          location: { display_name: "Remote" },
          category: { label: "IT Jobs" },
          created: "2026-01-01T00:00:00Z",
          redirect_url: "https://www.adzuna.com/land/ad/12345",
        },
      ],
    });
  }) as typeof fetch;
  try {
    const { postings, count } = await searchAdzunaPage(ENV, "software engineer", "remote", 1, 50);
    assert.match(requestedUrl, /^https:\/\/api\.adzuna\.com\/v1\/api\/jobs\/us\/search\/1\?/);
    assert.match(requestedUrl, /app_id=id123/);
    assert.match(requestedUrl, /app_key=key456/);
    assert.match(requestedUrl, /what=software\+engineer/);
    assert.match(requestedUrl, /where=remote/);
    assert.match(requestedUrl, /results_per_page=50/);
    assert.match(requestedUrl, /content-type=application%2Fjson/);
    assert.equal(count, 1);
    assert.deepEqual(postings, [
      {
        id: "12345", title: "Software Engineer", company: "Acme Inc", location: "Remote", category: "IT Jobs",
        created: "2026-01-01T00:00:00Z", url: "https://www.adzuna.com/land/ad/12345",
      },
    ]);
  } finally {
    globalThis.fetch = previous;
  }
});

test("searchAdzunaPage throws a distinguishable error without swallowing a bad response", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  try {
    await assert.rejects(() => searchAdzunaPage(ENV, "engineer", "", 1, 50), /adzuna_http_500/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("searchAdzunaPage distinguishes a rate limit from a generic failure", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response("slow down", { status: 429 })) as typeof fetch;
  try {
    await assert.rejects(() => searchAdzunaPage(ENV, "engineer", "", 1, 50), /adzuna_rate_limited/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("searchAdzunaPage refuses to run without credentials rather than sending an unauthenticated request", async () => {
  await assert.rejects(() => searchAdzunaPage({}, "engineer", "", 1, 50), /adzuna_not_configured/);
});

test("aggregateCompanies dedupes name variants and builds a sampled-title signal", () => {
  const postings: AdzunaPosting[] = [
    posting({ id: "1", title: "Backend Engineer", company: "Acme, Inc.", location: "Remote" }),
    posting({ id: "2", title: "Frontend Engineer", company: "Acme Inc", location: "Remote" }),
    posting({ id: "3", title: "Backend Engineer", company: "Acme Inc", location: "Remote" }),
  ];
  const companies = aggregateCompanies(postings);
  assert.equal(companies.length, 1, "Acme, Inc. and Acme Inc must dedupe via companyNameKey");
  assert.equal(companies[0].name, "Acme, Inc.", "keeps the first-seen display name");
  assert.equal(companies[0].postings_seen, 3);
  assert.match(companies[0].signal, /Backend Engineer/);
  assert.match(companies[0].signal, /Frontend Engineer/);
});

test("aggregateCompanies drops a repeated posting id instead of double-counting it", () => {
  // Same real posting seen twice -- two different search terms both matched it, or pagination
  // overlapped between calls. Must count once, not twice.
  const postings: AdzunaPosting[] = [
    posting({ id: "same-id", title: "Backend Engineer", company: "Acme Inc", location: "Remote" }),
    posting({ id: "same-id", title: "Backend Engineer", company: "Acme Inc", location: "Remote" }),
  ];
  const companies = aggregateCompanies(postings);
  assert.equal(companies.length, 1);
  assert.equal(companies[0].postings_seen, 1, "the repeated id must not inflate postings_seen");
});

test("aggregateCompanies never drops an id-less posting, since it can't collide with anything", () => {
  const postings: AdzunaPosting[] = [
    posting({ id: "", title: "Backend Engineer", company: "Acme Inc" }),
    posting({ id: "", title: "Frontend Engineer", company: "Acme Inc" }),
  ];
  const companies = aggregateCompanies(postings);
  assert.equal(companies[0].postings_seen, 2);
});

test("aggregateCompanies skips postings with no company name and returns [] for empty input", () => {
  assert.deepEqual(aggregateCompanies([]), []);
  assert.deepEqual(aggregateCompanies([posting({ title: "x" })]), []);
});
