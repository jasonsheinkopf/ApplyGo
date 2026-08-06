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
- **Companies** — your target-company list. Controls on the left (discovery search, location breakdown, manual add); the alphabetical list on the right with a filter box, each company showing its bio, site link, location, open-role count, and scan status, plus a per-company "Scan" button for spot-checking one board. Scanning *all* boards at once lives on the Jobs tab — see below. **Companies whose site never resolved, or whose board we scanned and found nothing supported on, are hidden by default** — they're never going to start yielding postings on their own, so surfacing them in the main list every scan is just noise. Kept in the database either way, behind a "Show companies that can't be scanned" checkbox, with badges (`site unreachable` / `no job board found`) explaining which. The summary line at the top splits "not scanned yet" (scanning again would help) from "can't be scanned" (it won't) — see "Company discovery and job scanning" below.
- **Jobs** — two explicit steps, in order. **1. Scan for new listings** — a "Companies to scan" selector (1 / 5 / 10 / **All**, default All) then reads that many boards and reports when it last ran and how many new listings turned up. **2. Filter for your best matches** runs the two-tier fit pipeline over whatever scanning found — see "Job filtering pipeline" below. Below both, the actual list: filterable by title, company, or location, with a **"Posted" freshness filter** (Any time / Last 24 hours / Last 3 days) and a **"Minimum score" filter** (Any / 50%+ / 70%+ / 90%+) — a posting with no known post date, or no score yet, always passes its respective filter rather than being penalized for missing data. Each posting links straight to the company's own listing, shows its fit score as a percentage badge, "Interested" pulls it onto the Interested tab (see below), and "Not for me" takes an optional reason that teaches future filtering. **The list shows only judged matches (green percentage badges, highest score first) by default.** Postings a fresh scan just found but hasn't been through the filter yet never mix into that view — they sit behind their own "Show postings not filtered yet" checkbox (yellow badge), under their own subheading, completely separate from postings the filter has actually ruled out (their own checkbox, their own subheading). Once a posting is marked Interested it leaves all three of those groups and only shows up on the Interested tab — it's no longer part of the Jobs tab's triage view at all.
- **Interested** — the jobs you've actually decided to go after, one master-detail view: a list of everything marked "Interested" on the Jobs tab (newest-marked first), and a detail section for whichever one is selected showing its title/company/location, the reason/score that made it interesting, a direct link to the posting, and "Remove interest" (which returns it to whatever bucket its existing score already implies, rather than resetting it to unassessed and losing that context — see `PATCH /jobs/:id/fit`'s `uninterested` action below). Below that, **Assistant / Resume / Cover letter / Apply are sub-tabs, not stacked sections** — only one panel shows at a time, the same way the dashboard's own top-level tabs work. Opening Resume then Cover letter used to leave both piled up on the page with no way back to looking at just one; now switching sub-tabs is how you get back, the same gesture as switching anywhere else in the app. See "Job assistant", "Job-tailored resume", and "Job cover letter" below for the first three. See "Application answers, and the `applied` stage" below for what **Apply** actually shows.
- **Applied** — jobs you've actually sent an application for, newest first, with an "applied N days ago" line and a "Not applied" undo. An applied job leaves the Jobs tab's buckets *and* the Interested list, so each tab shows exactly one stage of the funnel.
- **Devices** — device list/revoke

### Job assistant

The **Assistant** button (labeled "Review" until user feedback pointed out that word describes the wrong thing — it isn't reviewing anything, it's gathering more evidence) asks one short, conversational clarifying question about a gap between what the posting asks for and what the candidate's profile currently shows evidence of (`POST /jobs/:id/review` — the endpoint/route names keep their original wording since renaming a URL isn't user-facing; only on-screen copy changed). It uses `callText` rather than a JSON schema — a single sentence doesn't need structured output — reads the job's own description plus the full structured profile, and considers this job's previously-answered questions so a second click doesn't ask about the same thing twice. Nothing is written to the database until an answer is actually submitted.

Answering (`POST /jobs/:id/review-answer`) reuses `candidate_evidence` — the same table notes and role-signals already share, distinguished only by `category` — with a new `category = 'job_review'` and a real `job_id` column (`0010_job_review.sql`) rather than parsing it out of the pre-existing `metadata_json` field. The saved claim is `"Q: ...\nA: ..."` so the entry reads sensibly on its own later. This does **not** touch `candidate_profiles.structured_json`/`match_profile` — those only change through the existing explicit generate-then-save flow on the Profile tab, same as any other note.

**Answers are raw evidence, not resume content, and the compose prompt says so explicitly.** An earlier version folded these answers straight into a copy of the profile's `narrative_summary`, and the compose step ended up treating that block as already-written material and dropping it in close to verbatim, rather than doing the same rewrite-into-resume-language treatment every other piece of evidence gets. `jobReviewEvidenceInstructions()` (in `src/index.ts`) now builds an explicit block instead — labeled as the candidate's own words, with a direct instruction to rewrite it into proper resume phrasing (the same action+object+constraint+method+result shape and quantify-only-what's-given rule as everything else) and fold it into whichever existing experience entry it belongs to, never paste it in as its own bullet or section. This is passed via the compose call's `instructions` parameter — recomputed fresh on every résumé generation or revision (`buildJobResume`, `reviewResume`) rather than baked into the stored profile or the résumé row, so an answer added after a résumé already exists still reaches the very next revision. The cover-letter prompt got the same "these are real evidence, don't quote them verbatim" framing.

**Using an answer is optional, not mandatory.** The first version of this instruction told the model to fold every answer in somewhere ("if it doesn't fit any existing role, use it to strengthen the summary instead"), which left no room to skip an answer that was redundant, purely administrative, or otherwise not worth the space. Both `jobReviewEvidenceInstructions()` and the cover-letter prompt now say explicitly to use an answer only where it genuinely strengthens a specific point, and to leave it out rather than force it in when it wouldn't add anything a reader would value. Note that this only ever covers the per-job Assistant answers (`candidate_evidence` with `category = 'job_review'`) — the separate `application_answers` bank (work authorization, sponsorship, and the like — see below) never reaches résumé or cover-letter generation at all; it exists solely for the autofill extension.

### Job-tailored resume

"Resume" (`POST /jobs/:id/resume`) generates the one résumé version tailored to a specific posting, reusing the exact same compose → render → check pipeline (`buildResumeVersion` in `src/index.ts`, backed by `composeResumeDoc`/`renderResumeHtml`/`renderResumeArtifacts`/`runAllChecks` in `src/resume.ts`) that the Resume tab's general-purpose versions already go through — this is exactly the extension point `resume.ts`'s own header comment anticipated: only the "target" input changes, from general desired roles to `${job.title} at ${job.company}\n\n${job.raw_description}`.

Rather than trying to feed a prior version's saved content back into `composeResumeDoc` (composition always writes fresh from the profile — that's what the anti-fabrication guarantee depends on), a small model call (`decideResumeBase`) picks whichever existing general-purpose version is the closest stylistic fit and produces tailoring notes ("start from this one, but no changes are needed" / "emphasize X, trim Y"), which get folded into the `instructions` passed to compose. **The chosen version's own template and page-length (`layout_json`) are inherited too**, not just its written instructions — an earlier version of this forced every tailored résumé back to the 1-page classic default regardless of what the base version actually used, which is exactly why a candidate whose real versions target two pages kept seeing a "rendered to 2 pages but the target is 1" check on every attempt: the target itself was wrong, not the content. A failed base-selection call doesn't block generation — it just falls back to composing from the profile and job description alone (1-page classic default). Any answered `job_review` evidence for this job gets folded into a copy of the profile's `narrative_summary` before composing, since `checkGrounding` only validates employer/school names against the profile (never bullet content), so this is safe and gives the model real material without a path to invent anything.

Unlike general-purpose versions (which keep unbounded history — every "Generate" is a new row), **only one résumé exists per job**: `resumes.job_id` is unique in practice, and a resume already tailored for a job is returned as-is on the next click (the `reused: true` fast path) rather than regenerated. Preview reuses the existing `/resumes/:id/file` endpoint verbatim, since the result is just a normal `resumes` row.

**The Interested tab's preview always shows a direct "Open full PDF in a new tab" link alongside the embedded iframe**, because an embedded PDF viewer inside an iframe is unreliable on some phones — notably iOS Safari, which has a long-standing limitation where it often renders only a static first page, with no scrolling and no visible page break, regardless of what the PDF actually contains. The direct link opens the identical file as a real navigation instead of an embed, which uses the browser's own full PDF viewer (scrolling, pinch zoom, page breaks all intact). This mirrors a pattern the general Resume tab's list already had — each resume's name there has always linked straight to its PDF — which the Interested tab's inline preview was missing entirely until now.

**Iterating on a job-tailored résumé reuses the exact same "Revise" design-review loop the Resume tab already has** (`POST /resumes/:id/review`) rather than a separate blind regenerate. That endpoint screenshots the current render, has a vision model critique it, applies layout adjustments, and — if the critique calls for it — recomposes the content with that critique plus whatever the candidate typed in an optional comment box ("the comment outranks the model's opinion," per `reviewResumeDesign`'s own framing). An earlier version of this feature had "Regenerate for this job" just blindly redo the whole generation from scratch every time, with no comment box and no way for prior check failures to ever reach the model — which is why the same problems kept surviving three regenerations in a row: nothing was ever telling it what was wrong. `reviewResume` is now job-aware: a resume with a `job_id` keeps targeting that specific posting's title/company/description (plus its `job_review` evidence) through every revision, instead of drifting back toward the profile's general desired roles once a content rewrite triggers.

**Every generate or regenerate runs one design-review-and-revise pass automatically, before the candidate ever sees a version.** `buildJobResume` composes a first draft the same as always, then immediately calls `reviseOnce()` (in `src/index.ts`) — the exact same screenshot-critique-and-conditionally-recompose logic `reviewResume` uses for an explicit "Revise this version" click, just invoked once with no human comment yet. `reviseOnce` is shared code, extracted from what used to be `reviewResume`'s own body, so the on-demand revise endpoint and this automatic pass can't drift apart. Only the result of that second pass is stored and returned (one revision number, one critique), so what a candidate sees on the very first click is already the self-reviewed version rather than a rough draft they'd otherwise have to notice needs fixing and ask for a revision themselves. If the automatic pass itself fails for any reason, the first draft is returned instead of failing the whole request — polish is optional, a result isn't. This costs an extra vision-model call (and, when the critique calls for a content rewrite, a second compose call) on every generate/regenerate, which is a deliberate quality-for-latency tradeoff specifically for job-tailored résumés; the general Resume tab's versions are unaffected.

### Job cover letter

"Cover letter" (`POST /jobs/:id/cover-letter`) is new — no cover-letter code existed before this. It's deliberately lighter than the résumé pipeline: a single model call (`composeCoverLetter`) writes the letter text only (one `letter_body` string, same anti-fabrication framing as everything else — genuine, specific, nothing invented), and a small deterministic function (`renderCoverLetterHtml`) wraps it in a plain letterhead (name, date, paragraphs). No Puppeteer, no PDF, no R2 — the rendered HTML is stored directly in a new `cover_letters` table (`0012_cover_letters.sql`) and previewed via the iframe's `srcdoc`, so there's no extra request to fetch it back. A PDF/download version can be added later the same way résumés got theirs, if that turns out to matter.

Composing draws on whatever's already available for this job: the profile, the job description, any answered `job_review` evidence, and — if a job-tailored résumé already exists — its `contact_line`, so the letterhead doesn't have to guess at contact details or invent one. **One cover letter exists per job**, same storage pattern as the tailored résumé: `cover_letters.job_id` is unique, the existing letter is returned as-is unless the user clicks "Regenerate for this job" (which updates the row in place, no revision history since a cover letter is cheap to redo and always singular per application).

**A save failure after a successful compose no longer escapes as a raw, uncaught exception.** Reported as "nothing happens" when pressing Cover letter — the compose call itself was already wrapped in a try/catch, but the D1 write after it wasn't, so any failure there (a locked row, a constraint issue, anything) propagated straight to Cloudflare's default error response, which isn't JSON. The frontend's `res.json()` parse of that then threw its own opaque error, which the user is unlikely to have connected to "the cover letter failed to save." Both `buildCoverLetter` and `buildJobResume` now wrap their DB writes in their own try/catch, returning a clean `{error: "save_failed", detail}` either way. The frontend's `errorMessageFromResponse()` helper backs this up further: even if a response body genuinely isn't JSON, it falls back to a status-code-labeled message instead of letting the parse itself throw an unrelated error.

### Application answers, and the `applied` stage

Every ATS asks the same handful of questions (work authorization, sponsorship, veteran status, disability disclosure, notice period, salary expectations), and retyping them is most of the tedium of applying. `application_answers` (`0013_applications.sql`) is an ask-once-remember-forever bank, keyed by a **normalized question fingerprint** rather than the literal wording, so "Are you legally authorized to work in the United States?" and "Are you authorized to work in the US?" resolve to the same stored answer across different employers. `questionKey()` in `src/index.ts` does that normalization: it is deliberately crude and deterministic (strip punctuation and filler words, fold US/USA/United States together) because it runs on every field of every form and a stable, inspectable key matters more here than catching every possible rewording.

This is kept **separate from `candidate_evidence`** on purpose. That table holds free-text material a model reads and rewrites; these are exact values typed verbatim into a form field. Conflating them would invite a model to paraphrase an answer where only the literal string is correct, which for a legal question like work authorization is not an acceptable failure mode. Answers are visible and editable on the Profile tab, since the bank accumulates real personal data and has to be correctable. **This bank plays no part in résumé or cover-letter generation** — it exists solely for the autofill extension's `POST /applications/match`; the per-job Assistant Q&A (`candidate_evidence` with `category = 'job_review'`, described above) is the separate, unrelated source of evidence those documents actually draw on.

The dashboard fetches `application_answers` once at page load, so an answer saved elsewhere in the meantime (another browser tab, or the extension) wouldn't show up in the Apply tab's readiness count without a full reload. Opening the **Apply** sub-tab now refetches the bank every time — the same "don't trust cached client state, refetch on tab open" fix as the résumé/cover-letter rows described just below.

`applied` is a `fit_status` value following the same manual-override pattern `interested` already uses: `PATCH /jobs/:id/fit` gains `applied` (stamps `applied_at`) and `unapplied`. Two deliberate details. `applied` leaves `interested_at` set, because a job you applied to was necessarily one you were interested in, and keeping the timestamp means undoing restores its original position. And `unapplied` returns the job to **Interested**, not to the Jobs tab, because marking something applied by mistake shouldn't also discard the decision to pursue it.

The Interested tab's **Apply** sub-tab shows a readiness checklist (posting link, tailored résumé, cover letter, answers on file) and a "Mark as applied" button. The résumé and cover-letter rows read `has_resume`/`has_cover_letter`, columns `listJobs` computes with an `EXISTS` subquery against `resumes`/`cover_letters`, rather than tracking whether the dashboard happened to generate one earlier in the session -- otherwise switching jobs and back would show a document as missing that was actually generated days ago. The Resume and Cover letter sub-tabs use the same fields: opening either one for a job that already has a document loads and displays it immediately, through the existing no-LLM `reused: true` path, instead of waiting for another click on Generate/Draft. Autofill arrives with the browser extension; this is the tracking half of that feature, built first because it is useful on its own and is what the extension will read from.

### Autofill and the browser extension

`extension/` is a Manifest V3 browser extension (see its own README for install steps). It exists because server-side form filling does not work reliably: Cloudflare's headless browsers run from datacenter IPs that ATS bot detection flags, CAPTCHAs end an attempt with no recourse, and there is no way for the candidate to intervene mid-run. Running in the candidate's own browser solves all of that, and reading the live DOM means it works on job boards ApplyGo has never seen rather than only the four ATS platforms it can scan.

**It fills and stops. It never submits.** Submitting an application cannot be undone, and a mis-filled auto-submit is not recoverable, so the last click stays with the human. Filled fields are outlined blue, skipped ones amber.

`POST /applications/match` turns a live form into answers. Resolution runs cheapest and most trustworthy first: contact facts parsed deterministically from the profile label and the tailored résumé's `contact_line` (StructuredProfile models career history, not contact details), then the answer bank by normalized `questionKey()`, then one model call for whatever is left. **Anything unresolved comes back as `missing` rather than guessed**, including when the model call fails outright, so a provider outage degrades into "you answer these" instead of silently skipped fields.

**`NEVER_INFER` fields skip the model entirely.** Work authorization, sponsorship, citizenship, veteran status, disability, gender, race, criminal history, salary, notice period, start date, relocation, and security clearance are legally or personally consequential, and a confident guess is worse than no answer. Either the bank already holds it or the candidate is asked. The regex is stem-based (`disab\w*`, `relocat\w*`) because word-boundary matching silently missed "disability" and "relocate"; `scratchpad/ui/assert_never_infer.mjs` reads the pattern straight out of the source and checks 27 real question phrasings against it so the two cannot drift apart.

**Auth reuses the existing device sessions.** `requireSession` accepts `Authorization: Bearer` alongside the cookie, hashed against the same `device_sessions` table, and the extension enrolls through the ordinary one-time-code flow (`return_token: true` on `POST /auth/enroll` hands back the raw token, which the caller already receives via `Set-Cookie` anyway). So the extension shows up in the Devices tab and is revoked like any other device, with no second credential system to outlive a revoke. CORS is scoped to the handful of paths the extension calls and **never allows credentials**, which keeps cookie auth strictly same-origin: a cross-origin caller must present a bearer token, and only the enrolled extension has one.

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
- `POST /companies/bulk` (`{"text": string}`) — adds many companies from one pasted list, for a candidate who already has their own list of employers rather than wanting the model to discover some. Deliberately permissive about formatting: text is split on newlines, commas, *and* semicolons together, so "Acme, Beta Corp, Third Co" on one line works exactly the same as three separate lines — there's no reason to make someone reformat a list they already have just to fit a one-per-line rule. Each token also gets a leading bullet/number stripped (`- `, `1.`, `(2)`) and surrounding quotes removed (for a pasted CSV column). A token that looks like a URL or bare domain (`looksLikeUrl()`) attaches as the website of whichever name came right before it rather than becoming its own entry, so "Acme, https://acme.com, Beta Corp" reads as two companies, not three — checked narrowly enough that an internal period like "3M Co." or "Dr. Squatch" isn't mistaken for one. Capped at 50 parsed companies per call — comfortably more than anyone pastes in one sitting. Reuses `addCompanyRow()`, the same dedup-by-name-key insert the single-add form and discovery both go through, so a name already on the list is silently skipped rather than duplicated. This is deliberately separate from `POST /companies/discover`'s `count`/`focus` parameters: discovery is generative (the model proposes companies, curating and substituting as it sees fit), which is the wrong tool for "add exactly these 50 companies I already picked."
- `POST /companies/discover` (`{"provider"?, "count"?: 1-20, "focus"?: string}`) — proposes companies from the structured profile and Desired Roles, then **verifies each proposed site actually resolves** before trusting it. Reachable and unreachable entries are both stored, the latter flagged in the UI, because a model listing employers will occasionally invent or misremember one. Companies already on the list are passed into the prompt as exclusions *and* deduped on insert by a normalized name key, so `Acme, Inc.` and `Acme Inc` can't both land.
- `POST /companies/scan` (`{"limit"?: 1-12, "company_id"?: string}`) — reads job boards for companies that need it and writes the results into `job_postings`. Streams progress as newline-delimited JSON (see "Streaming progress" below) ending in `{"type":"done","scanned","results","new_listings","unscanned"}`, where `new_listings` is rows actually inserted this call via `meta.changes` — not just how many matched, since a re-scan legitimately re-matches postings it already has. Driven from the Jobs tab's "Scan for new listings" step for all companies at once; the per-company "Scan" button on the Companies tab calls the same endpoint with `company_id` set.

**No aggregators, by design.** Jobs come from each company's own board. Nearly every company runs that board on one of a handful of applicant tracking systems, and those publish plain public JSON APIs — Greenhouse (`boards-api.greenhouse.io`), Lever (`api.lever.co`), Ashby (`api.ashbyhq.com`), SmartRecruiters (`api.smartrecruiters.com`). So "check their site directly" is implemented by resolving *which* ATS a company uses and reading that board's API, which is structured and stable, rather than scraping a JavaScript-rendered careers page.

Board resolution runs in two steps: fetch the company's careers page and look for an outbound ATS link (the only thing scraped — job content always comes from the API), and if that finds nothing, try the company's own domain slug as a board token against each provider. The slug guess is cheap and correct surprisingly often, since most companies register their own name on their ATS. A company where neither works is marked `ats_provider = 'none'` with a note, so it isn't retried blindly.

**Companies known to be unreachable are excluded from the bulk scan.** A company whose site didn't resolve at discovery time (`status = 'unreachable'`, set by the `verifyWebsite()` check in `proposeCompanies`) is skipped by both `POST /companies/scan`'s target query and the "not scanned yet" pending count — retrying a dead site on every scan would just fail again and waste budget on the companies most likely to fail. The per-company `POST /companies/scan {"company_id"}` call has no such filter, so the Companies tab's per-row "Scan" button always works as a deliberate manual retry (the site may have come back up). Both `status = 'unreachable'` and `ats_provider = 'none'` (reachable, but no supported board found after actually scanning) are treated as "can't be scanned" on the dashboard — see the Companies tab description above.

Scanning is **batched against a shared subrequest budget** (each company costs a few outbound requests, and Workers cap subrequests per invocation), and the companies in a batch are **scanned concurrently, not one after another** — reading a board is a plain fetch with no LLM cost, so there's no reason for company #40 to wait on company #1 to finish first. `runPooled()` (`src/index.ts`) runs up to 8 companies at once, which is what turns "several minutes across multiple rounds" into "under a minute in one click" for a realistic company list: this used to require staying on the page to click "Scan company boards" again and again as each round finished, and a closed tab meant the remaining companies just sat unscanned until the page was reopened. The endpoint still reports how many companies remain unscanned in case the list is larger than one round's budget covers, but for the common case (dozens to a couple hundred companies) one click now clears the whole thing. Re-scanning is safe: a partial unique index on `(company_id, external_id)` makes posting inserts idempotent, and it's partial so manually added jobs — which have neither — are never caught by it. Scanned postings are filtered against your Desired Roles by title keyword, a deterministic pass that needs no model call.

**Location is a hard filter, enforced twice.** `candidate_profiles.preferences_json.desired_locations` (set on the Desired Roles tab) states where you'll actually work. Discovery puts it in the prompt as a hard constraint *and* re-checks every proposal against it on the way in, because a model reliably treats a stated location as guidance rather than a rule. Board scans apply the same check per posting, not per company — a company can qualify on location while most of its openings don't. Matching understands state abbreviations both ways (`CA` ↔ `California`) and common metro shorthand (`Bay Area`, `SoCal`, `NYC`), treats remote as always acceptable, and lets postings with no stated location through rather than dropping real results. Companies added before a location was set are flagged in the list instead of deleted, so tightening the filter never silently discards work.

Known limitation: discovery draws on the model's own knowledge, so it favors companies it knows and can be stale. The reachability check filters out names that don't resolve, but it can't tell you a company is currently hiring or still independent — that's what the scan step establishes. Wiring in a web-search API would improve recall and freshness; it isn't wired up, and would need another key and budget. Manual add is first-class for anything the model won't surface.

### Job filtering pipeline

Finding listings is cheap; judging them is not. The naive version — send every scraped posting to a strong model alongside the full profile — is the expensive way to do this, so the work is split into tiers that get progressively more costly and progressively fewer inputs:

| tier | what runs | cost | input per posting |
|---|---|---|---|
| 0 | location match + title keyword, in code | free | — |
| 1 | cheap model, binary keep/drop, 60 postings per call | low | title, location only |
| 2 | strong model, 0-100 fit score + reason + gaps, 8 per call | high | full stored description |

Two things make this work. **Scanning no longer judges anything** — `POST /companies/scan` only collects listings, so it stays fast and covers more companies per request. **`POST /jobs/process`** then runs tier 1 and tier 2 in that order against a shared call budget, reporting what remains at each stage so the dashboard just asks again. One "Find my matches" button drives the whole thing.

**Within a tier, every batch this round's budget can afford is fetched and fired at once, not one batch at a time.** The batches don't depend on each other (only tier 2 as a whole depends on tier 1 finishing first, since it reads tier 1's survivors), so there's no reason to wait for screen-batch #1's model call to return before starting screen-batch #2. `processJobs` fetches all eligible postings for the round up front, splits them into disjoint `SCREEN_BATCH_SIZE`/`FIT_BATCH_SIZE` chunks so concurrent calls never see overlapping rows, and runs up to 8 of those chunks at once through the same `runPooled()` helper `POST /companies/scan` uses. The per-call budget was raised from 12 to 24 alongside this, since firing calls concurrently rather than sequentially is what makes a bigger per-click budget actually usable in a reasonable amount of time.

### Streaming progress

Both `POST /companies/scan` and `POST /jobs/process` can process hundreds of items in a single call, so both stream progress rather than making the user stare at a static "please wait" until everything finishes. The response body is newline-delimited JSON (`ndjsonResponse` in `src/index.ts`): one `{"type":"progress",...}` line per unit of work as it completes (per company scanned; per screen or assess batch), ending in one `{"type":"done",...}` line with the same summary the endpoint used to return outright, or `{"type":"error","message"}` if something failed mid-stream.

The response starts streaming immediately — the handler's async work runs via `ctx.waitUntil()` after the `Response` (wrapping a `TransformStream`) is already returned, so the client sees the first progress line without waiting for the whole operation. The dashboard's `readNdjson()` helper reads the body with a `ReadableStreamDefaultReader`, splits on newlines (buffering a partial line across chunk boundaries), and updates the status text on every line — "Screening… 75 of 243", "Scanning… 2 of 6 companies (Applied Intuition)".

Progress here is a reporting layer, not a resilience mechanism in itself — the actual data safety comes from each unit of work being written to D1 *before* its progress line is emitted (already true of both loops: a company's listings are inserted, then its progress line goes out; a screen/assess batch is written, then its progress line goes out). So if the connection drops or the tab closes mid-stream, whatever was already written stays written — resuming is just clicking the button again, same as before this streamed at all. Now that companies and batches run concurrently rather than one at a time, progress lines arrive in *completion* order rather than list order (company #6 can finish before company #2), which doesn't change any of this — each line still only goes out after its own write lands, whichever one happens to finish first.

The cheap tier is deliberately **biased toward keeping**: it exists to remove obvious misses, and a wrong drop there is invisible to the user, so anything ambiguous survives to tier 2. Postings the model doesn't return a result for are also kept. Screened-out postings stay in the database rather than being deleted, so a re-scan never re-pays to reject them.

**Tier 1 judges on title and location alone, with no description.** A different profession or field (a mechanical/hardware role against a software profile) or a wildly off seniority word ("Staff"/"Director" vs. "Intern"/"Entry-Level") is obvious from the title, and dropping the description shrinks the per-posting prompt cost enough to raise the batch size (25 → 60 postings per call) for the same cost. Anything the title alone can't rule out — a stated years-of-experience minimum, a specific required tool, anything else that only shows up in the body — survives to tier 2, which reads the full description and can still catch it there.

`fit_status` is the pipeline's state machine: `unassessed` → `screened_out` | `screened_in` → `strong` | `possible` | `reject`. The Jobs tab shows matches and anything still queued, and hides only what a filter actually ruled out. Since tier 2 (below), `fit_status` for a scored posting is *derived* from its `fit_score` via `verdictForScore()` in `src/fit.ts` — the number is what's actually computed and stored; the bucket exists only so the rest of the pipeline's hide/show/sort logic doesn't need to know about scores.

**`interested` is a manual override on top of that state machine, the same way a user rejection already is.** `PATCH /jobs/:id/fit` gained two actions: `interested` sets `fit_status = 'interested'` and stamps `interested_at`, *without* touching `fit_score`/`fit_reason` — the score and reason that made it worth pursuing stay intact for the Interested tab to show. `uninterested` reverses it without the data loss a full `restore` would cause: it sets `fit_status` back to whatever `verdictForScore(fit_score)` already implies (or `unassessed` if it was never scored), rather than unconditionally wiping the score the way `restore` does. A posting with `fit_status = 'interested'` is excluded from all three of the Jobs tab's buckets (matches/queued/ruled-out) — it only appears on the Interested tab.

**`GET /jobs` returns every posting, uncapped.** It used to `LIMIT 300`, which was harmless while the table was small but started silently disagreeing with the dashboard's own pipeline summary once it wasn't: that summary counts every row in `job_postings` regardless of the cap, so a posting could be counted as a match up top while never actually reaching the browser to render, because it happened to sort outside the first 300 rows by post date. The fix is to just not cap it -- the two numbers can't drift apart if they're computed from the same set. This is safe to do because the query also stopped selecting `raw_description`, which the Jobs tab never displays (only `fit_reason` and `fit_missing_json` do) and which at up to 1500 characters per row was the actual weight in that response.

**Scanning all of a large company list took many repeated clicks against a fixed batch of 6.** The `limit` a scan request asks for barely matters for cost — the real governor is the fetch budget inside the loop, which already stops early and reports what's left regardless of how high `limit` goes. So the Companies-to-scan cap was simply raised (6 → 500) and the Jobs tab's "Companies to scan" selector defaults to **All**: a single request processes as many companies as the budget safely allows, and when "All" is selected the frontend re-fires the request on its own (capped at 25 rounds, as a backstop against a real server problem looping forever) until nothing's left, rather than making the user click through it by hand. Picking 1/5/10 instead still stops after one request, same as before.

**A company scanned earlier the same day is skipped on the next bulk scan.** `POST /companies/scan`'s target query excludes anything with `last_scanned_at` from today (`date(last_scanned_at) < date('now')`, in addition to never-scanned companies), and the `unscanned` count in its response is filtered the same way — so re-running a scan later the same day doesn't re-pay to re-read a board it just read, and the status line ("N companies still to scan today") reflects only what's actually left before the calendar day rolls over. A single-company rescan (by id, e.g. a manual retry) is unaffected — that path has always been a deliberate, explicit action.

**The compact match profile.** `candidate_profiles.match_profile` is a short rendering of the profile — headline, summary, roles, degrees, skills — capped at 2000 characters, and it is the candidate half of every screening call. It's built **deterministically** from `structured_json` rather than generated by a model: it costs nothing, is identical on every run, and cannot drift out of sync with the profile it describes the way a cached LLM summary would. The full structured profile runs several thousand characters and would otherwise be re-sent with every batch, which is exactly the input worth shrinking.

Model tiers are configured per provider — `ANTHROPIC_SCREEN_MODEL` (default `claude-haiku-4-5-20251001`) and `OPENAI_SCREEN_MODEL` (default `gpt-4o-mini`) for tier 1, `ANTHROPIC_MODEL` / `OPENAI_MODEL` for tier 2.

### Writing style rules

`WRITING_STYLE_RULES` in `src/llm.ts` is a single shared prompt block imported by every prompt whose output a human actually reads: résumé composition and design review (`src/resume.ts`), cover letters, the Assistant's question, desired-roles drafting, profile generation, and résumé base selection (`src/index.ts`), fit reasons (`src/fit.ts`), and company bios (`src/companies.ts`).

Its main job is banning the **em dash (—) and en dash (–)**, which is the single most recognizable tell that text was machine-written. A résumé that reads as AI-generated is worse than one that reads as merely plain. Ordinary hyphens inside real compound terms are explicitly *kept* ("full-stack", "end-to-end", "data-driven") because that is how those words are spelled, and stripping the hyphen would look wrong to a recruiter rather than natural. The block also names the specific filler phrases that show up most ("delve", "leverage" as a verb, "robust", "seamless", "passionate about") — not an exhaustive list, just enough to push the register away from them — and asks for varied sentence structure and no exclamation marks. The résumé and cover-letter prompts layer an additional formality instruction on top, since those two documents are the ones an employer actually sees.

**The cheap screen tier deliberately gets only the dash rule, not the whole block.** Its entire output is an eight-word fragment, and it runs at the highest volume of anything in the app (60 postings per call, many calls per session), so the rest of the guidance would be prompt cost buying nothing. Two prompts that feed *back into* composition — the design reviewer's `content_guidance` and `decideResumeBase`'s tailoring notes — do get the full block, because guidance written in the banned style reintroduces exactly what the résumé rules strip out.

Storage is bounded on the way in: scraped descriptions are capped at 1500 characters, which is more than tier 1 reads and enough for tier 2 to judge against. Descriptions are the largest column in the database, and the Data tab reports exactly how much space they take.

### Stored data and stage resets

The **Data** tab shows what's actually stored — row counts per collection, and byte totals for the two bulky text columns — and lets a developer reset the pipeline at any stage.

Stages are ordered, and resetting one clears **everything downstream of it**, because those results were derived from what's being removed: companies → listings → descriptions → screening/assessment. Resetting job descriptions, for example, also clears every fit verdict, since those verdicts were computed against descriptions that no longer exist. Each button states its downstream effect before confirming.

Hand-added postings are deliberately exempt from the listings reset (they have no `company_id` and are the user's own work), and are deletable separately alongside other standalone collections — rejection reasons, resumes, notes, role signals.

### Job fit assessment (tier 2)

The strong-model pass, run only on postings that survive screening (`src/fit.ts`). Rather than picking a label directly, the model rates each posting **0-100** and a fixed function (`verdictForScore`) buckets that into `strong` (≥70), `possible` (40-69), or `reject` (<40) for the parts of the app that only need the bucket. The score itself is what's stored and shown, so the Jobs tab can offer a real threshold instead of three fixed buckets — see the "Minimum score" filter there.

Scoring is calibrated so a single stated hard disqualifier (a language/tool with no evidence, a degree not held, a years-of-experience gap beyond the concrete rule below) caps the score low — 0-14 — regardless of how strong the rest of the overlap looks; a model isn't allowed to average a hard disqualifier away with an otherwise-good match. Every score comes with a one-sentence reason grounded in the specific requirement and the specific profile (mis)match, plus a list of concrete gaps. **Fails open**: a batch that errors, or a posting the model doesn't return, keeps its previous status and stays visible rather than silently disappearing; a posting the model returns nothing for defaults to 50 (the middle of the "possible" band), the same fail-open point the old three-way verdict used.

A manual "Not for me" rejection (no model involved) is stored as `fit_score = 0` — a confirmed non-fit sits at the bottom of the same scale a modeled score would use, so the badge stays meaningful either way.

**Rejections learn, but only from the user, on purpose.** `PATCH /jobs/:id/fit` (`{"action": "reject", "reason"?}` or `{"action": "restore"}`) is what the "Not for me" / "Restore" buttons call. A reason typed here is stored in `job_feedback` and fed into **both** filter tiers as a confirmed disqualifier. The AI's own low score is **not** added to `job_feedback` by itself — only a reason the user explicitly submits becomes a durable signal. That split matters: if the AI's own mistakes could reinforce themselves into permanent rules, one bad score could compound into a pattern of wrongly hidden postings with no way back. Restoring a posting clears its status and score without touching anything already learned.

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
- a tabbed, phone-usable dashboard (`/`): desired-roles description generation, profile edit, PDF/text/markdown document upload with real text extraction, freeform notes, AI-generated profile drafts (Anthropic or OpenAI), named resume versions across three templates with grounding/ATS/layout checks and a vision design-review loop, target-company discovery with direct job-board scanning, a two-tier job filtering pipeline (cheap bulk screen then strong-model assessment) with user-taught disqualifiers, a Data tab for inspecting stored data and resetting any pipeline stage, and device management

Still local-Python-only, or not built anywhere yet (not ported to Cloudflare):

- the deeper per-job-posting evaluation report the `fit_assessments` table was designed for (structured requirement-by-requirement breakdown with cited evidence, token usage, prompt versioning) — what's built now is the lighter fit verdict on `job_postings` described above, which covers "should I look at this" but not a full tailoring-grade assessment
- geocoded map of company locations — the Companies tab groups and filters by location text instead, which covers the actual use (seeing where the list clusters) without a geocoding dependency and external tile provider
- Workday-hosted job boards — per-tenant POST endpoints rather than a public GET API, so they need separate handling from the four supported ATS platforms
- per-job tailored resumes: requirement extraction from a posting, requirement→evidence matching, and the verification/reviewer stages — see the tracked design issue. The resume pipeline above is built to be reused for this; only the target input changes.
- outcome learning — recording which resume characteristics correlate with recruiter responses and interviews, and calibrating defaults from that. Needs application-outcome data the product doesn't collect yet, and needs enough volume for the correlation to mean anything.
- Playwright-based browser automation for applications
- export/import between local and Cloudflare mode

This directory is a control-plane foundation, not the completed Cloudflare product UI, but the phone-usable dashboard now covers the bulk of the personal-data-management surface (profile, documents, notes, desired roles, resumes, jobs, devices).
