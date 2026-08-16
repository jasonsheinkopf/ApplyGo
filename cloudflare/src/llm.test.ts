import assert from "node:assert/strict";
import test from "node:test";

import { callWithWebSearch, type LlmEnv } from "./llm.ts";

const ENV: LlmEnv = { ANTHROPIC_API_KEY: "key123" };

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
