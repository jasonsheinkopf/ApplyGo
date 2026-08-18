import assert from "node:assert/strict";
import test from "node:test";

import { ATS_IDENTITY_FLOOR, sweepAtsProviders } from "./atsdiscovery.ts";

/**
 * A minimal Greenhouse-shaped board page: enough for resolver.ts's scoreSiteMatch to recognize the
 * employer from the page title, the same signal a real Greenhouse-hosted board page carries.
 */
function boardPage(name: string): string {
  return `<html><head><title>${name} Jobs</title></head><body>Careers at ${name}. Open positions below.</body></html>`;
}

function mockFetch(routes: Record<string, { status?: number; body?: string }>) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input).split("?")[0];
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body ?? "", { status: route.status ?? 200 });
  }) as typeof fetch;
}

test("sweepAtsProviders finds a company's Greenhouse board from its name alone, no website needed", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch({
    "https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs": { body: '{"jobs":[{"id":1,"title":"Engineer"}]}' },
    "https://job-boards.greenhouse.io/acmerobotics": { body: boardPage("Acme Robotics") },
  });
  try {
    const budget = { remaining: 20 };
    const outcome = await sweepAtsProviders({ name: "Acme Robotics" }, budget);
    assert.equal(outcome.status, "found");
    if (outcome.status === "found") {
      assert.equal(outcome.provider, "greenhouse");
      assert.equal(outcome.token, "acmerobotics");
      assert.ok(outcome.confidence >= ATS_IDENTITY_FLOOR);
    }
    assert.ok(budget.remaining < 20, "must have spent real requests, not run unmetered");
  } finally {
    globalThis.fetch = previous;
  }
});

test("a board that exists at the guessed slug but names a different employer is rejected, not accepted", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch({
    // "Acme Robotics" guesses the slug "acmerobotics" -- a real, unrelated company's board that
    // happens to sit at the exact same slug must never be silently claimed as a match.
    "https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs": { body: '{"jobs":[{"id":1,"title":"Cashier"}]}' },
    "https://job-boards.greenhouse.io/acmerobotics": { body: boardPage("Totally Different Grocery Chain") },
  });
  try {
    const budget = { remaining: 20 };
    const outcome = await sweepAtsProviders({ name: "Acme Robotics" }, budget);
    assert.equal(outcome.status, "not_found");
    if (outcome.status === "not_found") {
      assert.ok(outcome.rejectedCandidate, "the rejected candidate must be surfaced for diagnostics");
      assert.equal(outcome.rejectedCandidate?.provider, "greenhouse");
    }
  } finally {
    globalThis.fetch = previous;
  }
});

test("the sweep is bounded: it does not fan out over every provider x every candidate unboundedly", async () => {
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const budget = { remaining: 1000 };
    const outcome = await sweepAtsProviders({ name: "Nowhere Company That Does Not Exist" }, budget);
    assert.equal(outcome.status, "not_found");
    assert.ok(requests <= 12, `expected a bounded request count, got ${requests}`);
    assert.equal(requests, 1000 - budget.remaining, "every real request must be metered against the shared budget");
  } finally {
    globalThis.fetch = previous;
  }
});

test("the sweep respects the shared fetch budget and stops once it's exhausted", async () => {
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const budget = { remaining: 2 };
    const outcome = await sweepAtsProviders({ name: "Some Company" }, budget);
    assert.equal(outcome.status, "not_found");
    assert.ok(requests <= 2, `must not exceed the shared budget, spent ${requests} against a budget of 2`);
    assert.ok(budget.remaining >= 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test("a candidate hit that runs out of budget before identity verification reports budget_exhausted, not a false negative", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockFetch({
    // The very first candidate's API check succeeds (real listings exist) but the budget is
    // exhausted by that single request, so there is nothing left to spend on the identity-page
    // verification fetch that would be needed before this could ever be accepted.
    "https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs": { body: '{"jobs":[{"id":1,"title":"Engineer"}]}' },
  });
  try {
    const budget = { remaining: 1 };
    const outcome = await sweepAtsProviders({ name: "Acme Robotics" }, budget);
    assert.equal(outcome.status, "not_found");
    if (outcome.status === "not_found") assert.equal(outcome.reason, "budget_exhausted");
  } finally {
    globalThis.fetch = previous;
  }
});

test("stops probing once a verified board is found -- later providers/candidates are not queried", async () => {
  const previous = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input).split("?")[0];
    requested.push(url);
    if (url === "https://boards-api.greenhouse.io/v1/boards/beta/jobs") {
      return new Response('{"jobs":[{"id":1,"title":"Engineer"}]}', { status: 200 });
    }
    if (url === "https://job-boards.greenhouse.io/beta") {
      return new Response(boardPage("Beta"), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const budget = { remaining: 20 };
    const outcome = await sweepAtsProviders({ name: "Beta" }, budget);
    assert.equal(outcome.status, "found");
    // Only greenhouse (the first provider tried) should ever have been queried -- lever, ashby,
    // workable, etc. must not be reached once a verified hit is already in hand.
    assert.ok(!requested.some((u) => u.includes("lever.co")), "lever must not be queried after a verified hit");
    assert.ok(!requested.some((u) => u.includes("ashbyhq.com")), "ashby must not be queried after a verified hit");
  } finally {
    globalThis.fetch = previous;
  }
});

test("an evidence URL discovery already supplied is tried before any slug is guessed", async () => {
  const previous = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input).split("?")[0];
    requested.push(url);
    if (url === "https://boards-api.greenhouse.io/v1/boards/realboard/jobs") {
      return new Response('{"jobs":[{"id":1,"title":"Engineer"}]}', { status: 200 });
    }
    if (url === "https://job-boards.greenhouse.io/realboard") {
      return new Response(boardPage("Real Employer"), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const budget = { remaining: 20 };
    const outcome = await sweepAtsProviders(
      { name: "Real Employer", urls: ["https://job-boards.greenhouse.io/realboard/jobs/123"] },
      budget,
    );
    assert.equal(outcome.status, "found");
    if (outcome.status === "found") assert.equal(outcome.token, "realboard");
  } finally {
    globalThis.fetch = previous;
  }
});
