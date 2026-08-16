#!/usr/bin/env node
// ApplyGo MCP server -- read-only.
//
// Transport wiring only. Every tool, schema, and filter lives in tools.ts so it can be tested
// without standing up a server; this file registers what that module exports and does nothing else.
//
// Configuration comes from the environment, so no credential is ever committed or passed on a
// command line where it would land in shell history:
//
//   APPLYGO_URL    base URL of the ApplyGo Worker  (default http://127.0.0.1:8787)
//   APPLYGO_TOKEN  a scope:'read_only' token from POST /devices/read-only  (required)
//
// See mcp/README.md for the Claude Desktop configuration.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { TOOLS, findTool } from "./tools.ts";

const baseUrl = process.env.APPLYGO_URL || "http://127.0.0.1:8787";
const token = process.env.APPLYGO_TOKEN || "";

if (!token) {
  // Fail loudly at startup rather than on the first tool call, where the error would surface to the
  // user as an unexplained tool failure inside their chat.
  console.error(
    "APPLYGO_TOKEN is not set.\n" +
      "Create a read-only token from a signed-in ApplyGo session:\n" +
      "  curl -X POST $APPLYGO_URL/devices/read-only -H 'authorization: Bearer <your session token>' \\\n" +
      "       -H 'content-type: application/json' -d '{\"label\":\"Claude Desktop\"}'\n",
  );
  process.exit(1);
}

const config = { baseUrl, token };

const server = new Server(
  { name: "applygo", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = findTool(request.params.name);
  if (!tool) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }] };
  }
  try {
    const result = await tool.run(config, request.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    // Reported as a tool error rather than thrown: the model can read this and tell the user what
    // to fix (expired token, ApplyGo not running) instead of the whole call failing opaquely.
    return { isError: true, content: [{ type: "text", text: `ApplyGo request failed: ${err.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
