import assert from "node:assert/strict";
import test from "node:test";

import { callWithWebSearch, type LlmEnv, modelFor, priceFor, screenProvider } from "./llm.ts";

const ENV: LlmEnv = { ANTHROPIC_API_KEY: "key123" };

// ---------------------------------------------------------------------------
// Per-tier provider selection
// ---------------------------------------------------------------------------

const BOTH_KEYS: LlmEnv = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" };

test("screening moves to the configured provider while the rest of the run stays put", () => {
  assert.equal(screenProvider({ ...BOTH_KEYS, SCREEN_PROVIDER: "openai" }, "anthropic"), "openai");
  assert.equal(screenProvider({ ...BOTH_KEYS, SCREEN_PROVIDER: "anthropic" }, "openai"), "anthropic");
});

test("an unset SCREEN_PROVIDER leaves both tiers on the run's own provider", () => {
  assert.equal(screenProvider(BOTH_KEYS, "anthropic"), "anthropic");
  assert.equal(screenProvider(BOTH_KEYS, "openai"), "openai");
});

test("a configured provider with no key falls back rather than failing half the pipeline", () => {
  const anthropicOnly: LlmEnv = { ANTHROPIC_API_KEY: "a", SCREEN_PROVIDER: "openai" };
  assert.equal(screenProvider(anthropicOnly, "anthropic"), "anthropic");

  const openaiOnly: LlmEnv = { OPENAI_API_KEY: "o", SCREEN_PROVIDER: "anthropic" };
  assert.equal(screenProvider(openaiOnly, "openai"), "openai");
});

test("an unrecognized SCREEN_PROVIDER value resolves to anthropic, never to undefined", () => {
  assert.equal(screenProvider({ ...BOTH_KEYS, SCREEN_PROVIDER: "gemini" }, "openai"), "anthropic");
});

const SCHEMA = { type: "object", properties: { official_website: { type: "string" } }, required: ["official_website"] };

test("callWithWebSearch sends both web_search and the caller's tool, without forcing tool_choice", async () => {
  const previous = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      content: [{ type: "tool_use", name: "submit_website", input: { official_website: "https://example.com" } }],
    });
  }) as typeof fetch;
  try {
    await callWithWebSearch(ENV, "test.task", "find the website", SCHEMA, "submit_website");
    const tools = requestBody.tools as { type?: string; name: string }[];
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, "web_search");
    assert.equal(tools[0].type, "web_search_20250305");
    assert.equal(tools[1].name, "submit_website");
    // The model must stay free to call web_search before the structured tool -- forcing tool_choice
    // (the way callStructured does) would make that impossible.
    assert.equal("tool_choice" in requestBody, false);
  } finally {
    globalThis.fetch = previous;
  }
});

test("callWithWebSearch picks the LAST tool_use block matching toolName, not a web_search block", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      content: [
        { type: "server_tool_use", name: "web_search", input: { query: "Acme Inc official site" } },
        { type: "web_search_tool_result", content: [] },
        { type: "text", text: "Based on my search, here is the answer." },
        { type: "tool_use", name: "submit_website", input: { official_website: "https://acme.example" } },
      ],
    })) as typeof fetch;
  try {
    const result = await callWithWebSearch<{ official_website: string }>(ENV, "test.task", "find it", SCHEMA, "submit_website");
    assert.equal(result.official_website, "https://acme.example");
  } finally {
    globalThis.fetch = previous;
  }
});

test("callWithWebSearch throws anthropic_no_search_result when the model never calls the structured tool", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ content: [{ type: "text", text: "I could not find this company." }] })) as typeof fetch;
  try {
    await assert.rejects(
      () => callWithWebSearch(ENV, "test.task", "find it", SCHEMA, "submit_website"),
      /anthropic_no_search_result/,
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test("callWithWebSearch surfaces the provider's error body on a non-ok response", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  try {
    await assert.rejects(
      () => callWithWebSearch(ENV, "test.task", "find it", SCHEMA, "submit_website"),
      /anthropic_error_429/,
    );
  } finally {
    globalThis.fetch = previous;
  }
});

// ---------------------------------------------------------------------------
// The reason tier's fallback model
// ---------------------------------------------------------------------------

test("the GPT-5.6 family is priced, so a fallback call records a cost rather than a null", () => {
  // An unpriced model records null, which is correct but makes the cost view blind to exactly the
  // spend that happens during an Anthropic outage -- the calls most worth accounting for.
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    assert.notEqual(priceFor(model), null, model);
  }
});

test("the reason tier falls back to a current-generation model, not the previous one", () => {
  assert.equal(modelFor({} as never, "openai", "reason"), "gpt-5.6-terra");
});

test("the screen tier stays on the cheap model -- it only ever sees a job title", () => {
  assert.equal(modelFor({} as never, "openai", "screen"), "gpt-4o-mini");
});

test("configured models still win over both defaults", () => {
  const env = { OPENAI_MODEL: "pinned-reason", OPENAI_SCREEN_MODEL: "pinned-screen" } as never;
  assert.equal(modelFor(env, "openai", "reason"), "pinned-reason");
  assert.equal(modelFor(env, "openai", "screen"), "pinned-screen");
});

test("the reason fallback is not priced above the model it replaced on input", () => {
  // The point of the upgrade is that it is a newer generation without being a cost regression on
  // the input side, which dominates here: a full posting in, a short verdict out.
  const terra = priceFor("gpt-5.6-terra");
  const legacy = priceFor("gpt-4o");
  assert.ok(terra && legacy);
  assert.ok(terra.in <= legacy.in, `${terra.in} should not exceed ${legacy.in}`);
});
