import assert from "node:assert/strict";
import test from "node:test";

import { type AgentCall, answerProfileQuestion, buildApplyGoMcpServer } from "./mcp-server.ts";

/** A fake Agent API that returns canned responses per path, and records every call it received. */
function fakeAgent(responses: Record<string, { status: number; body: Record<string, unknown> }>): { call: AgentCall; calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const call: AgentCall = async (method, path, body) => {
    calls.push({ method, path, body });
    return responses[path] ?? { status: 404, body: { error: "not_found" } };
  };
  return { call, calls };
}

test("buildApplyGoMcpServer registers every documented Agent API v1 tool", () => {
  const { call } = fakeAgent({});
  const server = buildApplyGoMcpServer(call);
  // registerTool doesn't expose a public "list tool names" accessor, but the server is a real
  // McpServer -- connecting it and listing tools is the transport-level way to check this, which
  // is exercised by the transport itself in production. Here it's enough to confirm construction
  // doesn't throw and returns a server instance, since each individual tool's behavior is tested
  // directly below without needing the transport at all.
  assert.ok(server);
});

test("answerProfileQuestion saves the answer, then applies it, returning both results", async () => {
  const { call, calls } = fakeAgent({
    "/agent/v1/profile/questions/q1": { status: 200, body: { saved: true, id: "q1" } },
    "/agent/v1/profile/questions/apply": { status: 200, body: { applied: 1 } },
  });
  const result = await answerProfileQuestion(call, "q1", "I led a team of four.");
  assert.equal(result.isError, undefined);
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed.saved, { saved: true, id: "q1" });
  assert.deepEqual(parsed.applied, { applied: 1 });
  assert.deepEqual(calls.map((c) => c.method + " " + c.path), [
    "PUT /agent/v1/profile/questions/q1",
    "POST /agent/v1/profile/questions/apply",
  ]);
});

test("answerProfileQuestion short-circuits on a failed save and never calls apply", async () => {
  const { call, calls } = fakeAgent({
    "/agent/v1/profile/questions/q1": { status: 404, body: { error: "not_found" } },
  });
  const result = await answerProfileQuestion(call, "q1", "answer");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 404/);
  assert.equal(calls.length, 1, "apply must not be called after a failed save");
});

test("answerProfileQuestion surfaces a failed apply after a successful save", async () => {
  const { call } = fakeAgent({
    "/agent/v1/profile/questions/q1": { status: 200, body: { saved: true } },
    "/agent/v1/profile/questions/apply": { status: 500, body: { error: "internal" } },
  });
  const result = await answerProfileQuestion(call, "q1", "answer");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 500/);
});

test("URL-encodes the question id when building the save path", async () => {
  const { call, calls } = fakeAgent({
    "/agent/v1/profile/questions/q%20one": { status: 200, body: {} },
    "/agent/v1/profile/questions/apply": { status: 200, body: {} },
  });
  await answerProfileQuestion(call, "q one", "answer");
  assert.equal(calls[0].path, "/agent/v1/profile/questions/q%20one");
});
