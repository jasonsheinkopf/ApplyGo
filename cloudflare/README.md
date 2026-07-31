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

### Reading production logs directly

`wrangler tail` (live log streaming) cannot work from a sandboxed/remote Claude Code session — it requires a WebSocket upgrade, which the session's outbound proxy does not support, regardless of credentials.

Instead, this Worker has `observability.enabled: true` set in `wrangler.jsonc`, and a session can query recent logs/exceptions directly over plain HTTPS via Cloudflare's Workers Logs REST API:

```
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/observability/telemetry/query
Authorization: Bearer <token>
Content-Type: application/json

{
  "queryId": "any-string",
  "timeframe": { "from": <epoch_ms>, "to": <epoch_ms> },
  "view": "events",
  "parameters": { "datasets": ["cloudflare-workers"], "filters": [], "limit": 20 }
}
```

This needs a token scoped to **Account → Workers Tail: Read** and **Account → Workers Observability: Edit** (Observability has no read-only permission tier). Ask Jason for a token with exactly those two permissions if one isn't already available; as with all tokens, use it inline for the request only, never write it to a file or commit it.

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

`GET /` is the phone-and-desktop-usable dashboard, gated by the same session cookie from enrollment (redirects to `/enroll` without a valid session). It's a single self-contained HTML page (no build step, no external assets, no frontend framework) with four tabs, calling the JSON endpoints below with `credentials: 'same-origin'`. Wide viewports (laptop/desktop, ≥760px) get a left/right split — inputs on the left, AI-generated output on the right, sticky so it stays in view while you scroll the left column; narrow viewports (phone) stack to one column. Long list items (notes, role signals) render as a single truncated line and expand on click, rather than dumping full text inline.

- **Desired Roles** — paste job links or write loosely about what you want next (left, `role_signal`-category `candidate_evidence` rows); generate a structured description of the roles you're targeting (right, Anthropic or OpenAI), stored in `candidate_profiles.preferences_json.desired_roles`
- **Profile** — your material (name, document upload, freeform notes) on the left; your AI-generated **structured** profile on the right
- **Resume** — your structured profile shown read-only on the left (sticky, for reference while the list on the right grows); on the right, named resume versions rendered as real PDFs. Pick a template, set a page target, type optional instructions ("emphasize leadership", "target a backend-heavy role"), and generate. Each version previews inline, shows its automated check results, and can be revised through a vision design review (with an optional comment to steer it). Every generate creates a **new** version — nothing is overwritten, so past versions stay available. See "Resume pipeline" below for how a version is actually produced.
- **Companies** — your target-company list. Controls on the left (search, scan, location breakdown, manual add); the alphabetical list on the right with a filter box, each company showing its bio, site link, location, open-role count, and scan status. See "Company discovery and job scanning" below.
- **Jobs** — openings found by scanning your target companies' boards, plus anything added by hand. Filterable by title, company, or location; each posting links straight to the company's own listing.
- **Devices** — device list/revoke

Authenticated data endpoints:

- `GET /profile` / `PUT /profile` — `PUT` only updates `label` (name) now. Response includes `desired_roles` (from `preferences_json`) and `structured` (parsed `structured_json`, or `null` if nothing generated yet). The first `candidate_profiles` row is created on first use (by any tab) and updated in place after that.
- `PUT /profile/structured` — saves an approved structured-profile draft (`{"structured": {...}}`) into `structured_json`, and mirrors `narrative_summary` into the legacy `summary` column.
- `GET /role-signals` / `POST /role-signals` / `DELETE /role-signals/:id` — freeform `candidate_evidence` rows (`category = 'role_signal'`)
- `PUT /desired-roles` — saves the reviewed description into `preferences_json.desired_roles`
- `POST /desired-roles/generate` — synthesizes a structured "roles you're looking for" description (still prose) from all role-signal notes, via Anthropic or OpenAI. Draft only, not auto-saved.
- `GET /jobs` / `POST /jobs` / `DELETE /jobs/:id` — `job_postings` rows (`title`, `company`, `source_url`, `raw_description`)
- `GET /documents` / `POST /documents` / `PATCH /documents/:id` / `DELETE /documents/:id` — `source_documents` rows backed by private R2 storage. Uploads accept PDF, plain text, or Markdown (15 MB limit, same as `/artifacts`). Text is extracted automatically for all three types: `text/plain`/`text/markdown` read directly, PDFs parsed with [`unpdf`](https://github.com/unjs/unpdf) (Cloudflare's own recommended edge-compatible PDF.js build — see [R2's PDF summarization tutorial](https://developers.cloudflare.com/r2/tutorials/summarize-pdf/)).
- `GET /documents/:id/file` (and `GET /artifacts/:key`) — streams the original file back with its real content-type and `Content-Disposition: inline`, so the dashboard's document name links open a browser-native preview (PDF viewer, plain text) in a new tab instead of forcing a download. Honors HTTP Range requests (`206 Partial Content` + `Content-Range`) — several PDF viewers, notably Adobe's browser plugin, fetch large PDFs in chunks and fail outright ("Failed to load PDF document") without that.
- `GET /notes` / `POST /notes` / `DELETE /notes/:id` — freeform `candidate_evidence` rows (`category = 'note'`) for unstructured facts about yourself, no file needed
- `POST /profile/generate` — synthesizes a **structured** profile — `headline`, `narrative_summary`, `education[]`, `experience[]` (with `highlights[]`), `skills[]` — from all notes and extracted document text (including parsed PDFs), using either Anthropic or OpenAI (`{"provider": "anthropic" | "openai"}`). Reliable JSON is enforced per-provider: Anthropic via forced tool-use with a JSON Schema, OpenAI via `response_format: {"type": "json_object"}`. Returns a draft only; it is never auto-saved. The dashboard shows it for review and only writes it via `PUT /profile/structured` once you click "Save this" — consistent with this project's human-supervised design (see `docs/product/progressive-autonomy.md`). The intent: this structured record is what later features (auto-filling applications, per-job tailoring) read from, instead of re-parsing unstructured text on every use.
  - **Regenerating is additive, not destructive.** The profile is meant to accumulate over time as you add material, not get overwritten from scratch on every regeneration. The prompt is given the current saved profile as an explicit baseline ("keep every entry the new material doesn't contradict") rather than as just one more source among equals, and a deterministic merge step (`mergeStructuredProfiles`) runs on the model's output regardless: any existing education/experience entry whose key (school+degree, or company+title) doesn't reappear in the new output is re-added automatically. This means a regeneration can only add or correct entries, never silently drop one just because the model didn't happen to re-mention it.
- `GET /resumes` / `POST /resumes` / `PATCH /resumes/:id` / `DELETE /resumes/:id` — named `resumes` rows, each an independent, never-overwritten version. `POST /resumes` (`{"instructions"?, "provider"?, "template"?: "classic" | "modern" | "compact", "max_pages"?: 1 | 2}`) runs the full pipeline described below. Auto-named from the instructions (or a date) at creation; rename afterward via `PATCH`.
- `POST /resumes/:id/review` (`{"comment"?: string, "provider"?}`) — the design-review loop. Re-renders the version, screenshots it, and has a vision model critique it; applies the resulting layout changes and, when the reviewer says the *writing* is the problem, re-composes the content from verified evidence with its guidance. A user `comment` outranks the model's own opinion. Bumps `revision` in place rather than creating a new named version.
- `GET /resumes/:id/file` — the rendered PDF, same Range-aware inline-preview treatment as `/documents/:id/file`.

### Company discovery and job scanning

- `GET /companies` / `POST /companies` / `PATCH /companies/:id` / `DELETE /companies/:id` — the target-company list. `PATCH` toggles `status` between `reachable` and `dismissed`, so a company can be set aside without losing it.
- `POST /companies/discover` (`{"provider"?, "count"?: 1-20, "focus"?: string}`) — proposes companies from the structured profile and Desired Roles, then **verifies each proposed site actually resolves** before trusting it. Reachable and unreachable entries are both stored, the latter flagged in the UI, because a model listing employers will occasionally invent or misremember one. Companies already on the list are passed into the prompt as exclusions *and* deduped on insert by a normalized name key, so `Acme, Inc.` and `Acme Inc` can't both land.
- `POST /companies/scan` (`{"limit"?: 1-12, "company_id"?: string}`) — reads job boards for companies that need it and writes the results into `job_postings`.

**No aggregators, by design.** Jobs come from each company's own board. Nearly every company runs that board on one of a handful of applicant tracking systems, and those publish plain public JSON APIs — Greenhouse (`boards-api.greenhouse.io`), Lever (`api.lever.co`), Ashby (`api.ashbyhq.com`), SmartRecruiters (`api.smartrecruiters.com`). So "check their site directly" is implemented by resolving *which* ATS a company uses and reading that board's API, which is structured and stable, rather than scraping a JavaScript-rendered careers page.

Board resolution runs in two steps: fetch the company's careers page and look for an outbound ATS link (the only thing scraped — job content always comes from the API), and if that finds nothing, try the company's own domain slug as a board token against each provider. The slug guess is cheap and correct surprisingly often, since most companies register their own name on their ATS. A company where neither works is marked `ats_provider = 'none'` with a note, so it isn't retried blindly.

Scanning is **batched against a shared subrequest budget** (each company costs a few outbound requests, and Workers cap subrequests per invocation). The endpoint reports how many companies remain unscanned and the dashboard simply calls it again, rather than risking one oversized request. Re-scanning is safe: a partial unique index on `(company_id, external_id)` makes posting inserts idempotent, and it's partial so manually added jobs — which have neither — are never caught by it. Scanned postings are filtered against your Desired Roles by title keyword, a deterministic pass that needs no model call.

**Location is a hard filter, enforced twice.** `candidate_profiles.preferences_json.desired_locations` (set on the Desired Roles tab) states where you'll actually work. Discovery puts it in the prompt as a hard constraint *and* re-checks every proposal against it on the way in, because a model reliably treats a stated location as guidance rather than a rule. Board scans apply the same check per posting, not per company — a company can qualify on location while most of its openings don't. Matching understands state abbreviations both ways (`CA` ↔ `California`) and common metro shorthand (`Bay Area`, `SoCal`, `NYC`), treats remote as always acceptable, and lets postings with no stated location through rather than dropping real results. Companies added before a location was set are flagged in the list instead of deleted, so tightening the filter never silently discards work.

Known limitation: discovery draws on the model's own knowledge, so it favors companies it knows and can be stale. The reachability check filters out names that don't resolve, but it can't tell you a company is currently hiring or still independent — that's what the scan step establishes. Wiring in a web-search API would improve recall and freshness; it isn't wired up, and would need another key and budget. Manual add is first-class for anything the model won't surface.

### Resume pipeline

The governing rule is **the model writes content, code owns layout**. Letting an LLM improvise CSS on every generation is what produces inconsistent, amateur output, so the stages are separated (`src/resume.ts`):

1. **Compose** (LLM, structured output) — builds a `ResumeDoc` from the structured profile *plus* your Desired Roles description as the target. This is a selection-and-rewriting step, not a reformat: it chooses what belongs on the page, rewrites raw profile highlights into achievement bullets, and groups skills. The prompt separates hard constraints (never invent an employer, title, date, credential, or metric; no content an ATS can't parse) from strong defaults (reverse chronological, experience dominant, lead with the strongest evidence) from tunable preferences, so instructions can override the last group without touching the first.
2. **Ground** (deterministic) — every employer and school on the resume is matched back against the profile it came from. Prompting alone can't guarantee the model didn't invent one, so this check exists regardless.
3. **Render** (deterministic) — one of three hand-built single-column templates (`classic`, `modern`, `compact`), sized by a small set of clamped layout knobs. All three avoid the constructs ATS vendors document as parsing hazards: no tables, no columns, no text boxes, no images, contact details in the body rather than a page header.
4. **Check** (deterministic) — the generated PDF is re-parsed with `unpdf` the way an applicant tracking system would read it, verifying the name, every employer, and every school actually survive text extraction, and that the page count matches the target. This catches the failure mode where a resume looks right to a human but parses to garbage. Writing-level checks (first-person pronouns, duty-phrase openers, overlong bullets) run alongside.
5. **Review** (vision model, on demand) — see `POST /resumes/:id/review` above. The reviewer may only move the clamped layout knobs or request a content rewrite; it cannot emit CSS, and it is explicitly told not to ask for photos, icons, skill bars, or multi-column layouts.

[Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/) (`@cloudflare/puppeteer`, the `BROWSER` binding) does the HTML→PDF step and the screenshot, in one browser session so the image the reviewer sees is the same rendering the PDF came from. Note that `page.pdf()` is used rather than `page.createPDFStream()`: R2's `put()` rejects a stream whose length it can't determine up front.

These stages are deliberately separable because per-job tailoring reuses all of them — only the target input changes, from the general Desired Roles description to a specific posting.

Model provider configuration:

- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — Worker secrets (`wrangler secret put ANTHROPIC_API_KEY --env production`), not vars, not committed. `/profile/generate`, `/desired-roles/generate`, and `/resumes` (`POST`) all return `501` for a provider whose key isn't set.
- `ANTHROPIC_MODEL` / `OPENAI_MODEL` — plain (non-secret) vars in `wrangler.jsonc`, defaulting to `claude-sonnet-5` and `gpt-4o`. Bump these here if a model id is retired.
- **Ollama is intentionally not wired into the Worker.** It runs on a local machine with no public address, so Cloudflare's servers cannot call it directly. Using it from the phone dashboard would need a separate local-worker/queued-job component (per `docs/architecture/local-cloudflare-dual-mode.md`'s "optional local worker" and ADR-015's "queued" execution mode) — that's a distinct, larger piece of future work, not a config setting.

This is a first slice, not the full local-Python product surface — nor the full evidence-vault/job-matcher/verifier/reviewer resume-tailoring pipeline described in issue tracking for future work. Job-fit *assessment against a specific posting*, per-job tailored resume generation targeting one posting, and outcome-based learning (tracking which resume characteristics actually correlate with interviews) aren't built yet — see "Current boundary" below.

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

Migrations in `migrations/` are forward-only and applied with `wrangler d1 migrations apply`, which tracks already-applied migrations per database (in its own ledger table) so each migration file only ever runs once, and never drops or recreates tables. The initial migration uses `CREATE TABLE IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS` for extra safety; later migrations that add columns (e.g. `0002_structured_profile.sql`'s `ALTER TABLE ... ADD COLUMN`) don't need that — SQLite has no `ADD COLUMN IF NOT EXISTS`, and Wrangler's per-migration tracking already prevents re-running it. Production migrations always run before deploy (`npm run release:production`), whether invoked manually or by Workers Builds.

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
- a tabbed, phone-usable dashboard (`/`): desired-roles description generation, profile edit, PDF/text/markdown document upload with real text extraction, freeform notes, AI-generated profile drafts (Anthropic or OpenAI), named resume versions across three templates with grounding/ATS/layout checks and a vision design-review loop, job posting list/add/remove, and device management

Still local-Python-only, or not built anywhere yet (not ported to Cloudflare):

- job-fit assessment generation *against a specific posting* (the `fit_assessments` table exists; nothing writes to it yet) — the Companies/Jobs tabs now supply the postings this would score
- geocoded map of company locations — the Companies tab groups and filters by location text instead, which covers the actual use (seeing where the list clusters) without a geocoding dependency and external tile provider
- Workday-hosted job boards — per-tenant POST endpoints rather than a public GET API, so they need separate handling from the four supported ATS platforms
- per-job tailored resumes: requirement extraction from a posting, requirement→evidence matching, and the verification/reviewer stages — see the tracked design issue. The resume pipeline above is built to be reused for this; only the target input changes.
- outcome learning — recording which resume characteristics correlate with recruiter responses and interviews, and calibrating defaults from that. Needs application-outcome data the product doesn't collect yet, and needs enough volume for the correlation to mean anything.
- Playwright-based browser automation for applications
- export/import between local and Cloudflare mode

This directory is a control-plane foundation, not the completed Cloudflare product UI, but the phone-usable dashboard now covers the bulk of the personal-data-management surface (profile, documents, notes, desired roles, resumes, jobs, devices).
