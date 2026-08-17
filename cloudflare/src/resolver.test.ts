import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIDENCE_FLOOR,
  extractSiteIdentity,
  isNonCompanyHost,
  normalizeSiteUrl,
  probePlan,
  resolveWebsiteDeterministic,
  scoreSiteMatch,
  verifyCandidate,
} from "./resolver.ts";

const page = (opts: { title?: string; siteName?: string; orgName?: string; body?: string } = {}) => `
<!doctype html><html><head>
${opts.title ? `<title>${opts.title}</title>` : ""}
${opts.siteName ? `<meta property="og:site_name" content="${opts.siteName}">` : ""}
${opts.orgName ? `<script type="application/ld+json">{"@type":"Organization","name":"${opts.orgName}","url":"https://x"}</script>` : ""}
</head><body>${opts.body ?? ""}</body></html>`;

/** Serves one canned response per hostname; anything else is a connection failure. */
function mockFetch(routes: Record<string, { status?: number; html?: string; finalUrl?: string }>) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const host = new URL(url).hostname;
    const route = routes[host];
    if (!route) throw new Error("ENOTFOUND");
    const res = new Response(route.html ?? "", { status: route.status ?? 200 });
    Object.defineProperty(res, "url", { value: route.finalUrl ?? url });
    return res;
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Probe plan
// ---------------------------------------------------------------------------

test("probePlan tries .com for every candidate before spending other TLDs", () => {
  const plan = probePlan("Green Dot Corporation");
  assert.equal(plan[0], "https://greendot.com", "the full cleaned name goes first");
  const comCount = plan.filter((u) => u.endsWith(".com")).length;
  assert.ok(comCount >= 2);
  assert.ok(plan.indexOf("https://greendot.org") > comCount - 1, ".org must come after every .com");
});

test("probePlan stays bounded -- this is what makes thousands of companies affordable", () => {
  // The naive candidates x TLDs cross-product was up to 49 requests/company and timed out in
  // benchmarking. Measured cost of this plan on the real backlog was 3.0 requests/company.
  assert.ok(probePlan("University of California, Irvine").length <= 10);
});

test("probePlan returns nothing for a name with no company content", () => {
  assert.deepEqual(probePlan("Careers Listing"), []);
});

// ---------------------------------------------------------------------------
// Non-company hosts
// ---------------------------------------------------------------------------

test("isNonCompanyHost rejects aggregators, social sites, and domain-parking hosts", () => {
  for (const url of [
    "https://www.linkedin.com/company/acme", "https://indeed.com/cmp/acme",
    "https://en.wikipedia.org/wiki/Acme", "https://hugedomains.com/acme", "https://x.com/acme",
  ]) {
    assert.equal(isNonCompanyHost(url), true, url);
  }
  assert.equal(isNonCompanyHost("https://acme.com"), false);
  assert.equal(isNonCompanyHost("not a url"), true, "an unparseable URL is never usable");
});

// ---------------------------------------------------------------------------
// Site identity extraction + scoring
// ---------------------------------------------------------------------------

test("extractSiteIdentity pulls title, og:site_name, and schema.org Organization name", () => {
  const id = extractSiteIdentity(page({ title: "DocuSign | Agreement Management", siteName: "DocuSign", orgName: "DocuSign, Inc." }));
  assert.equal(id.title, "DocuSign | Agreement Management");
  assert.equal(id.siteName, "DocuSign");
  assert.equal(id.orgName, "DocuSign, Inc.");
});

test("scoreSiteMatch rates a page that names itself as the company highly", () => {
  const { score } = scoreSiteMatch("DocuSign", page({ title: "DocuSign | Agreements", siteName: "DocuSign", orgName: "DocuSign, Inc.", body: "Careers at DocuSign" }));
  assert.ok(score >= CONFIDENCE_FLOOR, `expected a confident match, got ${score}`);
});

test("scoreSiteMatch refuses an unrelated site that merely owns a matching initialism", () => {
  // The exact false positive the real-data benchmark produced: "Match Made Tech" -> mmt.com.
  // Accepting this would send the candidate to a stranger's careers page.
  const { score } = scoreSiteMatch("Match Made Tech", page({ title: "MMT Travel Booking", siteName: "MakeMyTrip", orgName: "MakeMyTrip Limited" }));
  assert.ok(score < CONFIDENCE_FLOOR, `an unrelated initialism owner must not pass, got ${score}`);
});

test("scoreSiteMatch scores a parked/for-sale domain at zero regardless of its name", () => {
  const { score, evidence } = scoreSiteMatch("Acme Robotics", page({ title: "acmerobotics.com", body: "This domain is for sale. Buy this domain today." }));
  assert.equal(score, 0);
  assert.match(evidence, /parked|for-sale/i);
});

test("scoreSiteMatch cannot clear the floor on body mentions alone", () => {
  // A directory/news page mentions many companies. Body text is corroboration, never proof.
  const { score } = scoreSiteMatch("Avid Bioservices", page({ title: "Industry News Roundup", body: "avid bioservices announced results" }));
  assert.ok(score < CONFIDENCE_FLOOR, `body-only evidence must stay below the floor, got ${score}`);
});

test("scoreSiteMatch never uses the hostname itself, which would be circular", () => {
  // Same page content, wildly different hostnames -- the score must be identical.
  const html = page({ title: "Acme Robotics", orgName: "Acme Robotics" });
  assert.equal(
    scoreSiteMatch("Acme Robotics", html, "https://acme.com").score,
    scoreSiteMatch("Acme Robotics", html, "https://totally-unrelated.example").score,
  );
});

// ---------------------------------------------------------------------------
// Candidate verification
// ---------------------------------------------------------------------------

test("verifyCandidate returns null for an unreachable host rather than guessing", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch({});
  try {
    assert.equal(await verifyCandidate("Acme", "https://acme.com"), null);
  } finally {
    globalThis.fetch = previous;
  }
});

test("verifyCandidate rejects a candidate that redirects onto an aggregator", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch({ "acme.com": { html: page({ title: "Acme" }), finalUrl: "https://www.linkedin.com/company/acme" } });
  try {
    assert.equal(await verifyCandidate("Acme", "https://acme.com"), null);
  } finally {
    globalThis.fetch = previous;
  }
});

test("verifyCandidate reports a 403 as live-but-unconfirmed, below the acceptance floor", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch({ "acme.com": { status: 403 } });
  try {
    const result = await verifyCandidate("Acme", "https://acme.com");
    assert.ok(result);
    assert.ok(result.score < CONFIDENCE_FLOOR, "no body means no evidence, so it cannot be accepted");
  } finally {
    globalThis.fetch = previous;
  }
});

test("normalizeSiteUrl reduces to a stable https origin without www", () => {
  assert.equal(normalizeSiteUrl("http://www.acme.com/careers?x=1"), "https://acme.com");
});

// ---------------------------------------------------------------------------
// The waterfall
// ---------------------------------------------------------------------------

test("resolveWebsiteDeterministic accepts a validated guess and reports how it got there", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch({
    "docusign.com": { html: page({ title: "DocuSign", siteName: "DocuSign", orgName: "DocuSign, Inc.", body: "Careers" }) },
  });
  try {
    // "DocuSign Inc" only resolves because identity.ts strips the legal suffix first.
    const out = await resolveWebsiteDeterministic({ name: "DocuSign Inc" });
    assert.equal(out.status, "resolved");
    if (out.status !== "resolved") return;
    assert.equal(out.website, "https://docusign.com");
    assert.equal(out.source, "guess");
    assert.ok(out.confidence >= CONFIDENCE_FLOOR);
  } finally {
    globalThis.fetch = previous;
  }
});

test("resolveWebsiteDeterministic prefers discovery evidence over a guess", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch({
    "avidbio.com": { html: page({ title: "Avid Bioservices", orgName: "Avid Bioservices, Inc." }) },
    "avidbioservices.com": { html: page({ title: "Avid Bioservices", orgName: "Avid Bioservices, Inc." }) },
  });
  try {
    const out = await resolveWebsiteDeterministic({ name: "Avid Bioservices", urls: ["https://avidbio.com"] });
    assert.equal(out.status, "resolved");
    if (out.status !== "resolved") return;
    assert.equal(out.source, "evidence", "a URL discovery supplied beats a hostname guess");
    assert.equal(out.website, "https://avidbio.com");
  } finally {
    globalThis.fetch = previous;
  }
});

test("resolveWebsiteDeterministic returns ambiguous -- not resolved -- for an unrelated same-name site", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch({
    "mmt.com": { html: page({ title: "MakeMyTrip", siteName: "MakeMyTrip", orgName: "MakeMyTrip Limited" }) },
  });
  try {
    const out = await resolveWebsiteDeterministic({ name: "Match Made Tech" });
    assert.notEqual(out.status, "resolved", "an unrelated initialism owner must never be accepted");
    assert.ok(out.status === "ambiguous" || out.status === "unresolved");
  } finally {
    globalThis.fetch = previous;
  }
});

test("resolveWebsiteDeterministic reports unresolved when nothing is reachable", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch({});
  try {
    const out = await resolveWebsiteDeterministic({ name: "Nonexistent Widgets" });
    assert.equal(out.status, "unresolved");
  } finally {
    globalThis.fetch = previous;
  }
});

test("resolveWebsiteDeterministic never fabricates a website for a junk employer string", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch({});
  try {
    assert.equal((await resolveWebsiteDeterministic({ name: "Careers Listing" })).status, "unresolved");
  } finally {
    globalThis.fetch = previous;
  }
});

// ---------------------------------------------------------------------------
// Shared fetch budget -- this is what a scan batch's subrequest cap actually relies on staying
// accurate across every candidate URL this module tries, not just the ones resolveBoard knows about.
// ---------------------------------------------------------------------------

test("verifyCandidate never fetches once the shared budget is exhausted", async () => {
  const previous = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCount += 1;
    return mockFetch({ "acme.com": { html: page({ title: "Acme", orgName: "Acme Inc" }) } })(input);
  }) as typeof fetch;
  try {
    const budget = { remaining: 0 };
    const result = await verifyCandidate("Acme", "https://acme.com", budget);
    assert.equal(result, null, "an exhausted budget must refuse the fetch, not silently ignore it");
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test("verifyCandidate decrements a shared budget by exactly one per real fetch", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch({ "acme.com": { html: page({ title: "Acme", orgName: "Acme Inc" }) } });
  try {
    const budget = { remaining: 3 };
    await verifyCandidate("Acme", "https://acme.com", budget);
    assert.equal(budget.remaining, 2);
  } finally {
    globalThis.fetch = previous;
  }
});

test("resolveWebsiteDeterministic stops trying candidates once the shared budget runs out mid-probe", async () => {
  const previous = globalThis.fetch;
  const attempted: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    attempted.push(new URL(String(input)).hostname);
    throw new Error("ENOTFOUND");
  }) as typeof fetch;
  try {
    // probePlan("Some Company") normally tries 10 candidate URLs; a budget of 2 must cap it at 2.
    const budget = { remaining: 2 };
    const out = await resolveWebsiteDeterministic({ name: "Some Company" }, budget);
    assert.equal(out.status, "unresolved");
    assert.equal(attempted.length, 2, "must not spend more real fetches than the shared budget allows");
    assert.equal(budget.remaining, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test("resolveWebsiteDeterministic with no budget argument behaves exactly as before (unmetered)", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch({
    "docusign.com": { html: page({ title: "DocuSign", siteName: "DocuSign", orgName: "DocuSign, Inc.", body: "Careers" }) },
  });
  try {
    const out = await resolveWebsiteDeterministic({ name: "DocuSign Inc" });
    assert.equal(out.status, "resolved");
  } finally {
    globalThis.fetch = previous;
  }
});
