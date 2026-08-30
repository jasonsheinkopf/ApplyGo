import assert from "node:assert/strict";
import test from "node:test";

import {
  callWithWebSearch,
  estimateCostUsd,
  legacyThinkingBudget,
  modelFor,
  priceFor,
  resultsArray,
  screenProvider,
  thinkingConfig,
  type LlmEnv,
} from "./llm.ts";

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

// ---------------------------------------------------------------------------
// Sonnet 5's introductory rate became the standard rate
// ---------------------------------------------------------------------------

test("Sonnet 5 costs the same on either side of the old introductory cutoff", () => {
  // The $2/$10 launch rate was advertised as expiring 31 August 2026 and this table encoded the
  // step up to $3/$15. Anthropic confirmed the increase will not happen. Had the schedule stayed,
  // every Sonnet call from 1 September would have been costed 50% high -- and an overstatement
  // looks exactly like a real cost on a dashboard, so nothing would have flagged it.
  const august = estimateCostUsd("claude-sonnet-5", 1_000_000, 1_000_000, new Date("2026-08-31T00:00:00Z"));
  const september = estimateCostUsd("claude-sonnet-5", 1_000_000, 1_000_000, new Date("2026-09-01T00:00:00Z"));
  assert.equal(august, 12, "$2 in + $10 out per million");
  assert.equal(september, august, "the rate no longer changes at the cutoff");
});

test("a dated model snapshot still prices as its base model", () => {
  assert.deepEqual(priceFor("claude-haiku-4-5-20251001"), priceFor("claude-haiku-4-5"));
});

test("every model the bake-off compares is priced, or its cost reads as null", () => {
  // A model missing here records null rather than zero, which is correct but makes an arm of a
  // model comparison unscoreable on cost -- the whole point of running one.
  for (const model of [
    "claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5",
    "gpt-5.6-terra", "gpt-5.6-luna", "gpt-4o-mini",
  ]) {
    assert.notEqual(priceFor(model), null, model);
  }
});

// ---------------------------------------------------------------------------
// Structured responses whose array arrived as a string
// ---------------------------------------------------------------------------

test("a results array is returned unchanged", () => {
  assert.deepEqual(resultsArray<{ id: string }>({ results: [{ id: "a" }] }), [{ id: "a" }]);
});

test("a results array encoded as a JSON string is recovered, not discarded", () => {
  // Observed in production: Sonnet returned {"results":"[{...}]"} for one batch of eight job
  // assessments while returning a real array for the batches either side of it. The payload was
  // complete; only the encoding was wrong. The caller did results.map(...), threw, and threw away
  // all eight finished assessments and the tokens that produced them.
  const encoded = { results: JSON.stringify([{ id: "a", score: 78 }, { id: "b", score: 30 }]) };
  assert.deepEqual(resultsArray<{ id: string; score: number }>(encoded), [
    { id: "a", score: 78 },
    { id: "b", score: 30 },
  ]);
});

test("a genuinely malformed response degrades to empty rather than throwing", () => {
  // Empty lets the caller's own missing-result handling run. Throwing loses the whole batch.
  for (const payload of [
    { results: "not json at all" },
    { results: '{"not":"an array"}' },
    { results: 42 } as unknown as { results?: unknown },
    { results: null },
    {},
    null,
    undefined,
  ]) {
    assert.deepEqual(resultsArray(payload as never), []);
  }
});

// ---------------------------------------------------------------------------
// Deliberation budget
// ---------------------------------------------------------------------------

test("effort levels are ordered, and none means none", () => {
  assert.equal(legacyThinkingBudget("none"), 0);
  assert.ok(legacyThinkingBudget("low") < legacyThinkingBudget("medium"));
  assert.ok(legacyThinkingBudget("medium") < legacyThinkingBudget("high"));
});

test("the high budget is large enough to hold a whole reference set in mind", () => {
  // The reference ranking has to weigh ~25 postings against one profile and produce a defensible
  // ordering across all of them. A budget that only covers one posting at a time would produce 25
  // independent judgements, which is the thing the reference exists to improve on.
  assert.ok(legacyThinkingBudget("high") >= 16000, "high must be sized for whole-set reasoning");
});

// ---------------------------------------------------------------------------
// Thinking configuration -- the shape the API actually accepts
// ---------------------------------------------------------------------------

test("current models get adaptive thinking and an effort level, never a token budget", () => {
  // The fixed-budget form is not deprecated on these models, it is rejected with a 400. The first
  // implementation of this sent budget_tokens to Opus 5 and every call failed with
  // '"thinking.type.enabled" is not supported for this model'.
  for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-fable-5"]) {
    const config = thinkingConfig(model, "high") as Record<string, Record<string, unknown>>;
    assert.equal(config.thinking.type, "adaptive", model);
    assert.equal(config.output_config.effort, "high", model);
    assert.ok(!("budget_tokens" in config.thinking), `${model} must not be sent a token budget`);
  }
});

test("pre-4.6 models keep the fixed budget form, which is still correct for them", () => {
  const config = thinkingConfig("claude-haiku-4-5", "medium") as Record<string, Record<string, unknown>>;
  assert.equal(config.thinking.type, "enabled");
  assert.equal(config.thinking.budget_tokens, legacyThinkingBudget("medium"));
  assert.ok(!("output_config" in config), "effort is not a parameter these models accept");
});

test("no effort means no thinking configuration at all, on either generation", () => {
  assert.equal(thinkingConfig("claude-opus-5", "none"), null);
  assert.equal(thinkingConfig("claude-haiku-4-5", "none"), null);
});
