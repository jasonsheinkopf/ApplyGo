# ApplyGo MCP server (read-only)

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an MCP client — Claude
Desktop, Claude Code, or anything else that speaks MCP — query your ApplyGo data in conversation:

> What's the status of my Bain application?
> Show me the strongest AI roles currently in Good Fit.
> Which companies did ApplyGo fail to identify, and why?

It is **read-only**, and that is enforced in three overlapping places:

| Layer | Enforcement |
|---|---|
| This server | `callApplyGo` only ever issues `GET`. There is no code path that sends a request body. |
| ApplyGo | `requireSession` refuses any non-`GET` request from a `read_only` credential with a `403`. |
| The credential | The token is minted with `scope='read_only'` and stored only as a hash. |

The middle row is the one that actually matters, because it holds no matter what the client does —
including a modified copy of this server. It is a single check at ApplyGo's one authentication
choke point, so every mutating route is covered by construction, including routes added later. The
token cannot even mint another token.

## Setup

### 1. Start ApplyGo

```bash
cd cloudflare && npm run dev          # http://127.0.0.1:8787
```

### 2. Mint a read-only token

From a signed-in session (the dashboard sets `applygo_session`; the value below is that cookie, or
any full-scope device token):

```bash
curl -X POST http://127.0.0.1:8787/devices/read-only \
  -H "authorization: Bearer <your full session token>" \
  -H "content-type: application/json" \
  -d '{"label":"Claude Desktop"}'
```

```json
{ "token": "…", "scope": "read_only", "label": "Claude Desktop", "expires_in_days": 365 }
```

The raw token is shown **once** and only its hash is stored — there is no endpoint that reads it
back. If you lose it, revoke it and mint another. Revoke from Settings → Devices, same as any other
device.

### 3. Install dependencies

```bash
cd mcp && npm install
```

### 4. Point Claude Desktop at it

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "applygo": {
      "command": "node",
      "args": ["/absolute/path/to/ApplyGo/mcp/src/server.js"],
      "env": {
        "APPLYGO_URL": "http://127.0.0.1:8787",
        "APPLYGO_TOKEN": "paste-the-read-only-token-here"
      }
    }
  }
}
```

Restart Claude Desktop. ApplyGo's tools appear in the tools menu.

For a deployed Worker, set `APPLYGO_URL` to its URL and mint the token against that instance.

> The token lives in the client config, not in this repository. Nothing here reads a `.env`, and no
> credential should ever be committed.

## Tools

| Tool | Answers |
|---|---|
| `search_companies` | "Which companies are unresolved?" / "Which have unsupported job boards?" Filters on both state axes. |
| `get_company` | Everything known about one company, including the evidence behind its website — or why one was never confirmed. |
| `search_jobs` | Text, company, status, and minimum-score filters. Sorted best-fit first. |
| `get_job` | One job in full, including description, score, reasoning, and missing requirements. |
| `list_applications` | Everything applied to or marked interested. |
| `get_application_status` | "What's the status of my Acme application?" |
| `get_pipeline_summary` | Counts across the whole pipeline, with units attached. |

There are deliberately no tools that apply, edit, delete, dismiss, or send anything.

### Two state axes

Company results carry two independent statuses, and conflating them is the bug this model exists to
prevent:

- **`identity_status`** — is this a real, identified employer? `verified` / `ambiguous` /
  `unresolved` / `pending` / `not_a_company` / `dismissed`
- **`job_source_status`** — can ApplyGo read its jobs? `supported` / `unsupported_ats` /
  `careers_only` / `no_board` / `board_unreachable` / `pending`

A company can be perfectly **verified** and still have an **unsupported** board: that is a
limitation of ApplyGo's reach, not a defect in the employer.

## Development

```bash
npm test     # 22 tests; no network, no SDK transport, no live ApplyGo required
```

`src/tools.ts` holds every tool, schema, and filter. `src/server.js` is transport wiring only and
registers what that module exports — which is what makes the tools testable, including the assertion
that all of them only ever issue `GET` requests.
