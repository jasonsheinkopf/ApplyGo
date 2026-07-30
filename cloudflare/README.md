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

1. **Wrangler CLI with `CLOUDFLARE_API_TOKEN`** — the practical option for a sandboxed/remote Claude Code session, since interactive `wrangler login` needs a browser on the same machine as the CLI. Ask Jason for a custom-scoped token (Account → Workers Scripts: Edit, Account → D1: Edit — nothing else) stored as an environment variable for the session, never pasted into chat, committed, or put in GitHub Actions secrets.
2. **Jason running the command locally** — `wrangler login` works normally on his own machine, so `npm run release:production` or `wrangler secret put` can always be run by hand as a fallback.

Connecting **Workers Builds** to the GitHub repository (below) is a one-time dashboard action with no API/MCP equivalent as of this writing — Cloudflare's Git integration is configured under a Worker's **Settings → Builds** page.

## Automatic GitHub deployment (Cloudflare Workers Builds)

Production deploys are connected through Cloudflare's native Workers Builds GitHub integration, not a stored API token:

- Repository: `jasonsheinkopf/ApplyGo`
- Production branch: `main`
- Root directory: `cloudflare`
- Worker project: `applygo-prod`
- Build command: `npm install && npm run typecheck && npm run check:production`
- Deploy command: `npm run release:production`
- Build watch paths: `cloudflare/**`, `.github/workflows/cloudflare.yml`

A push to `main` that touches those paths automatically builds, applies pending D1 migrations, and deploys `applygo-prod`. Pushes that only touch unrelated paths (docs, the local Python app, résumé content, etc.) do not trigger a build. Pull requests run the same build/typecheck validation but do not deploy to production; Cloudflare preview builds (where available) are used instead of overwriting the live Worker.

## Enroll a phone or computer

1. From a trusted terminal, create a short-lived one-time code (requires the `SETUP_SECRET` value, never exposed to the browser):

   ```bash
   curl -X POST "https://YOUR-WORKER.workers.dev/admin/enrollments" \
     -H "content-type: application/json" \
     -H "x-applygo-setup-secret: YOUR_SETUP_SECRET" \
     -d '{"label":"Jason iPhone","minutes":15}'
   ```

2. On the device itself, open `https://YOUR-WORKER.workers.dev/enroll` in the browser and enter the code and a device name. This minimal page posts directly to `/auth/enroll`, receives the `Secure`, `HttpOnly`, `SameSite=Strict` session cookie, and verifies the session via `/me` — the code and session are never written to `localStorage` or exposed to any script beyond that one POST.

The enrollment code is single-use and expires (default 15 minutes, max 60). It cannot be exchanged again after use or after expiry.

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

Still local-Python-only (not ported to Cloudflare):

- the full candidate-profile Jinja/Python frontend and dashboard UI
- job-fit assessment generation and model-provider orchestration
- Playwright-based browser automation for applications
- profile/job/evidence CRUD APIs beyond the raw data model

This directory is a control-plane foundation, not the completed Cloudflare product UI. The next Cloudflare slice will add the responsive PWA, profile/job APIs, export/import, local-worker registration, and deployment automation beyond what is described here.
