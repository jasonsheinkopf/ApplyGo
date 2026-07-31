# ApplyGo Personal Cloudflare Mode

This directory contains the portable data and device-session control plane for a user-owned ApplyGo deployment.

It does not create a shared ApplyGo service. Every installer creates resources in their own Cloudflare account.

## Local development vs. production

`wrangler.jsonc` defines two configurations from one file:

- **Top-level config** — local development only. Worker name `applygo-personal`, D1 database `applygo`, R2 bucket `applygo-private`. Used by `npm run dev`, `npm run deploy`, `npm run migrate:local`, `npm run migrate:remote`.
- **`env.production`** — Jason's production deployment. Worker name `applygo-prod`, D1 database `applygo-prod-db`, R2 bucket `applygo-prod-private`. Used by any `*:production` script below, or `wrangler <cmd> --env production`.

Both configs bind the same names (`DB` for D1, `FILES` for R2) so `src/index.ts` does not need to know which environment it is running in.

## Resources (production)

- Worker: `applygo-prod`
- Production URL: `https://applygo-prod.jasonsheinkopf.workers.dev`
- D1 database: `applygo-prod-db`
- private R2 bucket: `applygo-prod-private`
- Worker secret: `SETUP_SECRET`

## First-time production setup

Install Node.js 20+ and authenticate Wrangler once (interactive OAuth, browser-based):

```bash
cd cloudflare
npm install
npx wrangler login
```

Create the production data resources (skip if they already exist — see "Claude Code infrastructure access" below for how this can be done without Wrangler at all):

```bash
npx wrangler d1 create applygo-prod-db
npx wrangler r2 bucket create applygo-prod-private
```

Copy the returned D1 database ID into `wrangler.jsonc` under `env.production.d1_databases[0].database_id`. A database ID is configuration, not a secret.

Create the production setup secret (value is never echoed or committed):

```bash
npx wrangler secret put SETUP_SECRET --env production
```

Apply the schema and deploy:

```bash
npm run migrate:remote:production
npm run deploy:production
```

Or run both in the correct order with one command:

```bash
npm run release:production
```

This is also the command Cloudflare Workers Builds runs on every push to `main` (see below), so migrations are never skipped before a deploy.

## Claude Code infrastructure access

Claude Code manages this account's Cloudflare resources through the **Cloudflare Developer Platform** MCP connector (OAuth-based, connected once via claude.ai connector settings). That connector's tool surface covers:

- listing/creating/inspecting D1 databases, R2 buckets, and KV namespaces
- running arbitrary D1 SQL (`d1_database_query`) — used to create/inspect tables directly, without needing `wrangler d1 migrations apply`
- listing/inspecting Workers (name, bindings) and reading a Worker's deployed source
- searching current Cloudflare documentation

It does **not** cover: uploading/deploying a Worker, setting Worker secrets, or connecting Workers Builds to a Git repository. For those three, a session needs one of:

1. **Wrangler CLI with `CLOUDFLARE_API_TOKEN`** — the practical option for a sandboxed/remote Claude Code session, since interactive `wrangler login` needs a browser on the same machine as the CLI. Ask Jason for a custom-scoped token (Account → Workers Scripts: Edit, Account → D1: Edit — nothing else) and use it for a single command invocation only; never write it to a file, commit it, or put it in GitHub Actions secrets or a cloud environment's plain environment-variable field (that field has no dedicated secrets store and is readable by anyone using the environment).
2. **Jason running the command locally** — `wrangler login` works normally on his own machine, so `npm run release:production` or `wrangler secret put` can always be run by hand as a fallback.

**A Claude Code cloud session's default network policy blocks Wrangler entirely.** Wrangler talks to `api.cloudflare.com` directly (not through the MCP connector's Anthropic-routed traffic), and a cloud environment's default **Trusted** network access level doesn't include Cloudflare's API. To let a session run Wrangler commands, the environment's **Network access** must be set to **Custom** with `api.cloudflare.com` (and, to reach the deployed Worker itself for verification, `*.workers.dev`) added to **Allowed domains** — see [Configure cloud environments](https://code.claude.com/docs/en/cloud-environments#network-access). This takes effect for new sessions only, not one already running.

Connecting **Workers Builds** to the GitHub repository (below) is a one-time dashboard action with no API/MCP equivalent as of this writing — Cloudflare's Git integration is configured under a Worker's **Settings → Builds** page.

## Automatic GitHub deployment (Cloudflare Workers Builds)

Production deploys are connected through Cloudflare's native Workers Builds GitHub integration, not a stored API token:

- Repository: `jasonsheinkopf/ApplyGo`
- Production branch: `main`
- **Root directory ("Path" in the dashboard): `cloudflare`** — required. Left at the default `/`, Cloudflare builds from the repo root, where there is no `package.json` (it's at `cloudflare/package.json`), and the build fails immediately with `npm error ... ENOENT ... package.json`.
- Worker project: `applygo-prod`
- Build command: `npm install && npm run typecheck && npm run check:production`
- Deploy command: `npm run release:production`
- **Non-production branch deploy command ("Version command" in the dashboard): `npx wrangler versions upload --env production`** — required, `--env production` included. Without it, Wrangler falls back to the top-level (local-dev) config on every PR build: wrong D1/R2 bindings, and a fatal `binding DB of type d1 must have a valid database_id` error, since the dev D1 entry is a placeholder.
- Build watch paths: `cloudflare/**`, `.github/workflows/cloudflare.yml`

A push to `main` that touches those paths automatically builds, applies pending D1 migrations, and deploys `applygo-prod` live (the **Deploy command**). Pushes that only touch unrelated paths (docs, the local Python app, résumé content, etc.) do not trigger a build. Pull requests run the same build/typecheck validation and upload a new Worker Version (the **Non-production branch deploy command**), which does not receive live traffic — it validates the deploy path without affecting the running Worker.

## Enroll a phone or computer

**From a machine with Wrangler logged in** (`npx wrangler login`, once per machine — real Cloudflare OAuth, no token needed): create a short-lived one-time code directly in D1, no `SETUP_SECRET` required:

```bash
cd cloudflare
npm run enroll -- "Jason's Laptop" 15
```

This prints a one-time code. On the device you're enrolling, open `https://applygo-prod.jasonsheinkopf.workers.dev/enroll`, enter the code and a device name. The page posts directly to `/auth/enroll`, receives the `Secure`, `HttpOnly`, `SameSite=Strict` session cookie, and verifies the session via `/me` — the code and session are never written to `localStorage` or exposed to any script beyond that one POST.

**Alternative, without a local dev environment**: the `POST /admin/enrollments` endpoint does the same thing over HTTP, gated by the `SETUP_SECRET` Worker secret instead of a Wrangler login:

```bash
curl -X POST "https://applygo-prod.jasonsheinkopf.workers.dev/admin/enrollments" \
  -H "content-type: application/json" \
  -H "x-applygo-setup-secret: YOUR_SETUP_SECRET" \
  -d '{"label":"Jason iPhone","minutes":15}'
```

`SETUP_SECRET` was set with a randomly generated value that was never displayed or recorded anywhere (`openssl rand -base64 32 | wrangler secret put SETUP_SECRET --env production`), so this path isn't usable until you rotate it yourself (`wrangler secret put SETUP_SECRET --env production`, this time actually keeping the value somewhere safe if you want to use this endpoint).

Either way, the enrollment code is single-use and expires (default/max above, 15 and 60 minutes respectively for `npm run enroll`). It cannot be exchanged again after use or after expiry.

## Dashboard

`GET /` is the phone-usable dashboard, gated by the same session cookie from enrollment (redirects to `/enroll` without a valid session). It's a single self-contained HTML page (no build step, no external assets, no frontend framework) with four tabs, calling the JSON endpoints below with `credentials: 'same-origin'`:

- **Desired Roles** — paste job links or write loosely about what you want next (`role_signal`-category `candidate_evidence` rows); generate a structured description of the roles you're targeting (Anthropic or OpenAI), stored in `candidate_profiles.preferences_json.desired_roles`
- **Profile** — name/summary, document upload, freeform notes, and AI profile generation
- **Jobs** — job posting list/add/remove
- **Devices** — device list/revoke

Authenticated data endpoints:

- `GET /profile` / `PUT /profile` — single-profile model (`label`, `summary`); returns `desired_roles` too (read from `preferences_json`). The first `candidate_profiles` row is created on first use (by any tab) and updated in place after that.
- `GET /role-signals` / `POST /role-signals` / `DELETE /role-signals/:id` — freeform `candidate_evidence` rows (`category = 'role_signal'`)
- `PUT /desired-roles` — saves the reviewed description into `preferences_json.desired_roles`
- `POST /desired-roles/generate` — synthesizes a structured "roles you're looking for" description from all role-signal notes, via Anthropic or OpenAI. Draft only, not auto-saved.
- `GET /jobs` / `POST /jobs` / `DELETE /jobs/:id` — `job_postings` rows (`title`, `company`, `source_url`, `raw_description`)
- `GET /documents` / `POST /documents` / `PATCH /documents/:id` / `DELETE /documents/:id` — `source_documents` rows backed by private R2 storage. Uploads accept PDF, plain text, or Markdown (15 MB limit, same as `/artifacts`). Text is extracted automatically for all three types: `text/plain`/`text/markdown` read directly, PDFs parsed with [`unpdf`](https://github.com/unjs/unpdf) (Cloudflare's own recommended edge-compatible PDF.js build — see [R2's PDF summarization tutorial](https://developers.cloudflare.com/r2/tutorials/summarize-pdf/)).
- `GET /notes` / `POST /notes` / `DELETE /notes/:id` — freeform `candidate_evidence` rows (`category = 'note'`) for unstructured facts about yourself, no file needed
- `POST /profile/generate` — synthesizes a long-form narrative profile from the existing summary + all notes + all extracted document text (including parsed PDFs), using either Anthropic or OpenAI (`{"provider": "anthropic" | "openai"}`). Returns a draft only; it is never auto-saved. The dashboard shows it for review and only writes it into `summary` once you click "Use this draft" and then "Save profile" — consistent with this project's human-supervised design (see `docs/product/progressive-autonomy.md`).

Model provider configuration:

- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — Worker secrets (`wrangler secret put ANTHROPIC_API_KEY --env production`), not vars, not committed. Both `/profile/generate` and `/desired-roles/generate` return `501` for a provider whose key isn't set.
- `ANTHROPIC_MODEL` / `OPENAI_MODEL` — plain (non-secret) vars in `wrangler.jsonc`, defaulting to `claude-sonnet-5` and `gpt-4o`. Bump these here if a model id is retired.
- **Ollama is intentionally not wired into the Worker.** It runs on a local machine with no public address, so Cloudflare's servers cannot call it directly. Using it from the phone dashboard would need a separate local-worker/queued-job component (per `docs/architecture/local-cloudflare-dual-mode.md`'s "optional local worker" and ADR-015's "queued" execution mode) — that's a distinct, larger piece of future work, not a config setting.

This is a first slice, not the full local-Python product surface — nor the full evidence-vault/job-matcher/verifier/reviewer resume-tailoring pipeline described in issue tracking for future work. Job-fit *assessment against a specific posting*, per-job tailored resume generation, formatted resume rendering, and evidence verification workflows aren't ported. See "Current boundary" below.

## Device management

Authenticated endpoints:

- `GET /me`
- `GET /devices`
- `POST /devices/:id/revoke`
- `POST /auth/logout`

A lost phone can be revoked from another remembered device. Revoking the current device also clears its cookie.

## Private files

Authenticated file endpoints:

- `POST /artifacts` using multipart field `file`
- `GET /artifacts/:key`

Uploads are limited to 15 MB and PDF, plain text, or Markdown in this initial slice. R2 objects are not made public; the bucket has no public access binding or custom domain.

## Secrets and credential handling

- `SETUP_SECRET` lives only in Cloudflare's Worker secret store (`wrangler secret put ... --env production`), never in Git, GitHub Actions secrets, or this repository.
- Device sessions store only a SHA-256 hash of the session token in D1 (`device_sessions.token_hash`), never the raw token.
- Enrollment codes store only a SHA-256 hash (`enrollment_codes.code_hash`), never the raw code.
- No Cloudflare API token, GitHub token, or model-provider key is ever sent to browser JavaScript.
- Automatic GitHub deployment uses Cloudflare Workers Builds' native Git integration, which does not require storing a Cloudflare API token in GitHub Actions secrets.

## Migrations

Migrations in `migrations/` are forward-only, idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), and applied with `wrangler d1 migrations apply`, which tracks already-applied migrations per database and never drops or recreates tables. Production migrations always run before deploy (`npm run release:production`), whether invoked manually or by Workers Builds.

## Rollback

- **Worker code**: `npx wrangler deployments list --env production` to find a prior version ID, then `npx wrangler rollback <version-id> --env production`. This is instant and does not touch D1/R2 data.
- **Cloudflare Workers Builds**: the dashboard's Deployments tab for `applygo-prod` also supports re-promoting any previous successful build.
- **D1 schema**: migrations are additive/idempotent by convention; a destructive rollback is not automated on purpose. If a migration needs to be reverted, add a new forward migration that undoes it rather than editing or deleting an applied migration file.
- **Secrets**: `npx wrangler secret put SETUP_SECRET --env production` again to rotate; old sessions and enrollment codes already issued keep working until they naturally expire (secret rotation does not invalidate existing session hashes, since sessions are keyed by their own token, not by `SETUP_SECRET`).

## Current boundary — Cloudflare vs. local Python

Hosted in Cloudflare today:

- reproducible D1 schema
- private R2 binding
- one-time device enrollment, including the `/enroll` browser page
- hashed session-token storage and remembered secure browser sessions
- device listing and revocation
- authenticated private artifact transfer (`/artifacts`)
- a tabbed, phone-usable dashboard (`/`): desired-roles description generation, profile edit, PDF/text/markdown document upload with real text extraction, freeform notes, AI-generated profile drafts (Anthropic or OpenAI), job posting list/add/remove, and device management

Still local-Python-only (not ported to Cloudflare):

- the full candidate-profile Jinja/Python frontend and dashboard UI
- job-fit assessment generation and model-provider orchestration
- Playwright-based browser automation for applications
- profile/job/evidence CRUD APIs beyond the raw data model

This directory is a control-plane foundation, not the completed Cloudflare product UI. The next Cloudflare slice will add the responsive PWA, profile/job APIs, export/import, local-worker registration, and deployment automation beyond what is described here.
