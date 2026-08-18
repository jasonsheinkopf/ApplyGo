import assert from "node:assert/strict";
import test from "node:test";

import { resolveWebsiteViaSearch } from "./websearch.ts";

const ENV = { ANTHROPIC_API_KEY: "key123" };

function mockAnthropic(input: Record<string, unknown>) {
  const fn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages?: { content: string }[] };
    // Capture the compiled prompt on the mock itself so a test can inspect it.
    (fn as unknown as { lastPrompt?: string }).lastPrompt = body.messages?.[0]?.content ?? "";
    return Response.json({
      content: [{ type: "tool_use", name: "submit_website_resolution", input }],
    });
  }) as typeof fetch;
  return fn;
}

test("resolveWebsiteViaSearch uses the bundled default prompt when Langfuse isn't configured, and lists supported ATS providers", async () => {
  const previous = globalThis.fetch;
  const fetchMock = mockAnthropic({
    official_website: "https://acme.example",
    careers_url: "",
    ats_board_url: "",
    confidence: 80,
    reason: "official site confirmed via search",
  });
  globalThis.fetch = fetchMock;
  try {
    const result = await resolveWebsiteViaSearch(ENV, { name: "Acme Inc", location: "", signal: "" });
    assert.ok(result);
    assert.equal(result?.official_website, "https://acme.example");
    const prompt = (fetchMock as unknown as { lastPrompt?: string }).lastPrompt ?? "";
    assert.match(prompt, /Greenhouse/i, "the bundled prompt must name the ATS providers this app actually supports");
    assert.match(prompt, /Acme Inc/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("resolveWebsiteViaSearch surfaces a proposed ATS board URL alongside (or instead of) a website", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = mockAnthropic({
    official_website: "",
    careers_url: "",
    ats_board_url: "https://job-boards.greenhouse.io/stevesinsurance",
    confidence: 55,
    reason: "found their Greenhouse board via search, could not confirm a corporate site",
  });
  try {
    const result = await resolveWebsiteViaSearch(ENV, { name: "Steve's Insurance", location: "", signal: "" });
    assert.equal(result?.official_website, "");
    assert.equal(result?.ats_board_url, "https://job-boards.greenhouse.io/stevesinsurance");
  } finally {
    globalThis.fetch = previous;
  }
});

test("resolveWebsiteViaSearch returns null rather than throwing when no API key is configured", async () => {
  const result = await resolveWebsiteViaSearch({}, { name: "Acme Inc", location: "", signal: "" });
  assert.equal(result, null);
});
