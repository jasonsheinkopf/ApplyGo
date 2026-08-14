import assert from "node:assert/strict";
import test from "node:test";

import { compilePrompt, getManagedPrompt, type ManagedPrompt } from "./langfuse.ts";
import { callStructured } from "./llm.ts";

test("compiles alphabetic and underscore variables exactly", () => {
  assert.equal(compilePrompt("Hello {{first_name}}.", { first_name: "Ada" }), "Hello Ada.");
});

test("fails clearly when a prompt variable is missing", () => {
  assert.throws(
    () => compilePrompt("Hello {{first_name}} from {{company}}", { first_name: "Ada" }),
    /langfuse_prompt_missing_variables:company/,
  );
});

test("retrieves the production prompt and returns its trace metadata", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /roles%2Fcriteria%2Fextract\?label=production$/);
    return Response.json({ id: "prompt-id", name: "roles/criteria/extract", version: 3, type: "text", prompt: "Read {{criteria_text}}" });
  };
  try {
    const prompt = await getManagedPrompt(
      { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "https://test.invalid" },
      "roles/criteria/extract",
      { criteria_text: "salary" },
    );
    assert.deepEqual(prompt, { text: "Read salary", name: "roles/criteria/extract", version: 3, id: "prompt-id" });
  } finally {
    globalThis.fetch = previous;
  }
});

test("uses the persistent last-known-good prompt when Langfuse is unavailable", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  const cached = { id: "cached-id", name: "jobs/prescreen", version: 2, type: "text", prompt: "Screen {{postings}}" };
  const db = {
    prepare: () => ({
      bind: () => ({ first: async () => ({ prompt_json: JSON.stringify(cached) }) }),
    }),
  } as unknown as D1Database;
  try {
    const prompt = await getManagedPrompt(
      { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "https://offline.invalid", DB: db },
      "jobs/prescreen",
      { postings: "[]" },
    );
    assert.equal(prompt.text, "Screen []");
    assert.equal(prompt.version, 2);
  } finally {
    globalThis.fetch = previous;
  }
});

test("structured calls keep provider routing and schemas in code", async () => {
  const previous = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ content: [{ type: "tool_use", input: { ok: true } }], usage: { input_tokens: 4, output_tokens: 2 } });
  };
  const prompt: ManagedPrompt = { text: "Managed instruction", name: "jobs/prescreen", version: 1, id: "id" };
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
  try {
    const value = await callStructured<{ ok: boolean }>(
      { ANTHROPIC_API_KEY: "test" },
      "anthropic",
      "fit.screen",
      prompt,
      schema,
      "submit_screen",
      4000,
      "screen",
    );
    assert.deepEqual(value, { ok: true });
    assert.equal(requestBody.model, "claude-haiku-4-5-20251001");
    assert.deepEqual((requestBody.messages as { content: string }[])[0], { role: "user", content: "Managed instruction" });
    assert.deepEqual((requestBody.tools as { input_schema: unknown }[])[0].input_schema, schema);
  } finally {
    globalThis.fetch = previous;
  }
});
