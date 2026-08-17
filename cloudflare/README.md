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

## Enroll a device

Enrollment gives a browser a device session. Each enrollment code can be used once and expires
quickly; after it is accepted, the browser keeps the session in a secure cookie. Enrolled sessions
can be reviewed or revoked from **Settings → Devices** in ApplyGo.

### Local development

1. Create `cloudflare/.dev.vars` if it does not exist and add a local setup secret:

   ```dotenv
   SETUP_SECRET=anything-you-pick
   ```

2. Restart the local server after adding or changing `.dev.vars`:

   ```bash
   cd cloudflare
   npm run dev
   ```

3. In a second terminal, from the `cloudflare` directory, generate a one-time code. The optional
   arguments are the device label and expiration in minutes (1–60, default 15):

   ```bash
   npm run enroll:local -- "Jason's MacBook" 15
   ```

4. Open `http://localhost:8787/enroll` on the browser being enrolled. Enter the printed code and a
   device name. Successful enrollment verifies the session and redirects to the ApplyGo dashboard.

If `enroll:local` returns `403 {"error":"forbidden"}`, the running Worker and the script are using
different `SETUP_SECRET` values—usually because `.dev.vars` was changed without restarting
`npm run dev`. Confirm the file contains exactly one `SETUP_SECRET=...` line, restart the server,
and generate a new code.

### Production

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

- **Desired Roles** — paste job links or write loosely about what you want next (left, `role_signal`-category `candidate_evidence` rows, collapsed behind a "Notes on file" disclosure once there are more than a couple, so a long history doesn't push the add-note form down the page); generate a structured description of the roles you're targeting (right, Anthropic or OpenAI), stored in `candidate_profiles.preferences_json.desired_roles`, alongside Dealbreakers and "What do you care about?" (see "Job fit assessment (tier 2)" below)
- **Profile** — your material (name, document upload, freeform notes) on the left; your AI-generated **structured** profile on the right; **Application answers in its own full-width section below both.** It sat as a fourth stacked block inside "Your material" until the UI audit, which made the left column run roughly twice the height of the right one; it also isn't source material for the structured profile the way documents and notes are, so it reads better as its own thing.
- **Resume** — your structured profile shown read-only on the left (sticky, for reference while the list on the right grows); on the right, named resume versions rendered as real PDFs. Pick a template, set a page target, type optional instructions ("emphasize leadership", "target a backend-heavy role"), and generate. Each version previews inline, shows its automated check results, and can be revised through a vision design review (with an optional comment to steer it). Every generate creates a **new** version — nothing is overwritten, so past versions stay available. See "Resume pipeline" below for how a version is actually produced.
- **Companies** — one "Find companies" button (no count to choose, no AI provider to pick — the whole pipeline is deterministic, see "Company discovery and job scanning" below), a search-focus field, and a staged Discovery → Verify → (Jobs) Pre-screen summary on the Search tab. A **Verified / Unverified / Removed** segmented control shows everything already found: Verified rows show ATS/scan status and a per-row "Scan" button; Unverified rows show a plain-language reason (with filter chips for the four reason codes) and a manual "Save website" fix. There is no fit score or Good/Bad Fit split anywhere on this tab — a company is never judged "relevant" here, only whether it's a real, monitorable employer; whether a specific opening actually fits the candidate is judged entirely on the Jobs tab.
- **Search** (on the Companies/Jobs tabs) — a single button on each tab, no manual batch-size choice: the fetch/LLM-call budget inside each step's own endpoint is what actually bounds cost, so there's nothing a smaller number would save. Reading job boards (Discovery/Verify on the Companies side) is the shared step both tabs drive (`POST /companies/discover` then `POST /companies/scan`); judging what a scan turns up is Jobs-only (`POST /jobs/process`) — Companies has no judging step of its own, see "Company discovery and job scanning" and "Job filtering pipeline" below.
- **Jobs** — the results list this produces, filterable by title, company, or location, with a **"Posted" freshness filter** (Any time / Last 24 hours / Last 3 days), a **"Minimum score" filter** (Any / 50%+ / 60%+ / 70%+ / 80%+ / 90%+ / 100%), and a **"Sort by" control** (Best match / Recently processed / Recently posted) — a posting with no known post date, no score yet, or that hasn't been through tier 2 always passes its respective filter and sorts to the end rather than being penalized for missing data. Each posting links straight to the company's own listing, shows its fit score as a percentage badge, "Interested" pulls it onto the Interested tab (see below), and "Not for me" takes an optional reason that teaches future filtering. **The list shows only judged matches (green percentage badges, highest score first by default) by default, with a Sort by control to switch to recently processed or recently posted instead.** Postings a fresh scan just found but hasn't been through the filter yet never mix into that view — they sit behind their own "Show postings not filtered yet" checkbox (yellow badge), under their own subheading, completely separate from postings the filter has actually ruled out (their own checkbox, their own subheading). Once a posting is marked Interested it leaves all three of those groups and only shows up on the Interested tab — it's no longer part of the Jobs tab's triage view at all.
- **Jindr** — the same matches as the Jobs tab, but one at a time instead of a scrolling list: always sorted best-match-first, each card showing the score, years-required/remote/salary facts, the fit reason, and the gap list, with green "Interested" / red "Not for me" buttons (and drag-to-swipe on top) calling the exact same actions the Jobs tab's own buttons do. See "Jindr: one-at-a-time swipe review" below.
- **Interested** — the jobs you've actually decided to go after, one master-detail view: a list of everything marked "Interested" on the Jobs tab (newest-marked first, title linking straight to the posting exactly like the Jobs tab row it came from), and a detail section for whichever one is selected showing its title/company/location, the reason/score that made it interesting, a direct link to the posting, and "Remove interest" (which returns it to whatever bucket its existing score already implies, rather than resetting it to unassessed and losing that context — see `PATCH /jobs/:id/fit`'s `uninterested` action below). Below that, **Ask / Resume / Cover / Apply are sub-tabs, not stacked sections** — only one panel shows at a time, the same way the dashboard's own top-level tabs work. Opening Resume then Cover used to leave both piled up on the page with no way back to looking at just one; now switching sub-tabs is how you get back, the same gesture as switching anywhere else in the app. The row scrolls horizontally rather than wrapping if it doesn't fit (the `.subtabs` CSS class, same pattern the top-level nav bar already uses), which is also why the labels are as short as they are — "Assistant"/"Cover letter" wrapped a button onto its own second line on a phone-width screen. See "Job assistant", "Job-tailored resume", and "Job cover letter" below for the first three. See "Application answers, and the `applied` stage" below for what **Apply** actually shows.
- **Applied** — jobs you've actually sent an application for, newest first, with an "applied N days ago" line and a **"Mark not applied"** undo (it was "Not applied", which read as a status contradicting the "N applications sent" line directly above it rather than as the action it performs). An applied job leaves the Jobs tab's buckets *and* the Interested list, so each tab shows exactly one stage of the funnel.
- **Devices** — device list/revoke

### Job assistant

The **Assistant** button (labeled "Review" until user feedback pointed out that word describes the wrong thing — it isn't reviewing anything, it's gathering more evidence) asks one short, conversational clarifying question about a gap between what the posting asks for and what the candidate's profile currently shows evidence of (`POST /jobs/:id/review` — the endpoint/route names keep their original wording since renaming a URL isn't user-facing; only on-screen copy changed). It uses `callText` rather than a JSON schema — a single sentence doesn't need structured output — reads the job's own description plus the full structured profile, and considers this job's previously-answered questions so a second click doesn't ask about the same thing twice. Nothing is written to the database until an answer is actually submitted.

A bare question makes people freeze on a blank page even when they have a relevant story — they just don't immediately connect it to the ask. So the prompt doesn't only ask; it's told to actually look through the candidate's profile for one or two specific, real things (a project, an employer, a tool) that plausibly relate to the gap, name them, and float them as tentative possibilities — "maybe something like the migration project at Acme, or was it more informal?" — giving the candidate something concrete to react to, correct, or build on instead of an empty prompt. It's explicitly told to only reference things that actually appear in the profile (a confident wrong guess is worse than no guess) and to ask straight instead of forcing a stretch when nothing plausibly connects.

Answering (`POST /jobs/:id/review-answer`) reuses `candidate_evidence` — the same table notes and role-signals already share, distinguished only by `category` — with a new `category = 'job_review'` and a real `job_id` column (`0010_job_review.sql`) rather than parsing it out of the pre-existing `metadata_json` field. The saved claim is `"Q: ...\nA: ..."` so the entry reads sensibly on its own later. This does **not** touch `candidate_profiles.structured_json`/`match_profile` — those only change through the existing explicit generate-then-save flow on the Profile tab, same as any other note.

**Answers are raw evidence, not resume content, and the compose prompt says so explicitly.** An earlier version folded these answers straight into a copy of the profile's `narrative_summary`, and the compose step ended up treating that block as already-written material and dropping it in close to verbatim, rather than doing the same rewrite-into-resume-language treatment every other piece of evidence gets. `jobReviewEvidenceInstructions()` (in `src/index.ts`) now builds an explicit block instead — labeled as the candidate's own words, with a direct instruction to rewrite it into proper resume phrasing (the same action+object+constraint+method+result shape and quantify-only-what's-given rule as everything else) and fold it into whichever existing experience entry it belongs to, never paste it in as its own bullet or section. This is passed via the compose call's `instructions` parameter — recomputed fresh on every résumé generation or revision (`buildJobResume`, `reviewResume`) rather than baked into the stored profile or the résumé row, so an answer added after a résumé already exists still reaches the very next revision. The cover-letter prompt got the same "these are real evidence, don't quote them verbatim" framing.

**Using an answer is optional, not mandatory.** The first version of this instruction told the model to fold every answer in somewhere ("if it doesn't fit any existing role, use it to strengthen the summary instead"), which left no room to skip an answer that was redundant, purely administrative, or otherwise not worth the space. Both `jobReviewEvidenceInstructions()` and the cover-letter prompt now say explicitly to use an answer only where it genuinely strengthens a specific point, and to leave it out rather than force it in when it wouldn't add anything a reader would value. Note that this only ever covers the per-job Assistant answers (`candidate_evidence` with `category = 'job_review'`) — the separate `application_answers` bank (work authorization, sponsorship, and the like — see below) never reaches résumé or cover-letter generation at all; it exists solely for the autofill extension.

### Job-tailored resume

"Resume" (`POST /jobs/:id/resume`) generates the one résumé version tailored to a specific posting, reusing the exact same compose → render → check pipeline (`buildResumeVersion` in `src/index.ts`, backed by `composeResumeDoc`/`renderResumeHtml`/`renderResumeArtifacts`/`runAllChecks` in `src/resume.ts`) that the Resume tab's general-purpose versions already go through — this is exactly the extension point `resume.ts`'s own header comment anticipated: only the "target" input changes, from general desired roles to `${job.title} at ${job.company}\n\n${job.raw_description}`.

Rather than trying to feed a prior version's saved content back into `composeResumeDoc` (composition always writes fresh from the profile — that's what the anti-fabrication guarantee depends on), a small model call (`decideResumeBase`) picks whichever existing general-purpose version is the closest stylistic fit and produces tailoring notes ("start from this one, but no changes are needed" / "emphasize X, trim Y"), which get folded into the `instructions` passed to compose. **The chosen version's own template and page-length (`layout_json`) are inherited too**, not just its written instructions — an earlier version of this forced every tailored résumé back to the 1-page classic default regardless of what the base version actually used, which is exactly why a candidate whose real versions target two pages kept seeing a "rendered to 2 pages but the target is 1" check on every attempt: the target itself was wrong, not the content. A failed base-selection call doesn't block generation — it just falls back to composing from the profile and job description alone (1-page classic default). Any answered `job_review` evidence for this job gets folded into a copy of the profile's `narrative_summary` before composing, since `checkGrounding` only validates employer/school names against the profile (never bullet content), so this is safe and gives the model real material without a path to invent anything.

Unlike general-purpose versions (which keep unbounded history — every "Generate" is a new row), **only one résumé exists per job**: `resumes.job_id` is unique in practice, and a resume already tailored for a job is returned as-is on the next click (the `reused: true` fast path) rather than regenerated. Preview reuses the existing `/resumes/:id/file` endpoint verbatim, since the result is just a normal `resumes` row.

**The downloaded filename is `<Candidate Name>_Resume_<Company>.pdf`, not the résumé's own display name.** That display name is `"<job title> @ <company>"` — fine as a label in a list, but a poor filename once several of them pile up in the same downloads folder: long, punctuation-heavy, and dominated by the job title rather than the one thing that actually tells two files apart at a glance. `getResumeFile` builds the `Content-Disposition` filename separately by joining `resumes` to `job_postings` (for the company) and `candidate_profiles` (for `label`, the candidate's name), sanitizing each part (`safeFilenamePart()`: no path separators or quotes, spaces to underscores) — so a résumé tailored for Zipline downloads as `Jason_Sheinkopf_Resume_Zipline.pdf`. A general-purpose version with no `job_id` falls back to its own `name` in that last slot instead, since there's no company to use.

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

### The application agent and the browser extension

`extension/` is a Manifest V3 browser extension (see its own README for install steps and its internal architecture). It exists because server-side form filling does not work reliably: Cloudflare's headless browsers run from datacenter IPs that ATS bot detection flags, CAPTCHAs end an attempt with no recourse, and there is no way for the candidate to intervene mid-run. Running in the candidate's own browser solves all of that, and reading the live DOM means it works on job boards ApplyGo has never seen rather than only the four ATS platforms it can scan.

**It fills and stops. It never submits.** Submitting an application cannot be undone, and a mis-filled auto-submit is not recoverable, so the last click stays with the human. Filled fields are outlined blue, unresolved ones amber. **There is no Skip.** A field the agent can't resolve on its own stays visibly unresolved until the candidate fills it, saves it, or — only when the employer's own form marks it optional — explicitly leaves it blank; a required field can never be dismissed unanswered.

**The handoff is the Interested card's Apply button.** The whole card, title included, is one accordion control; **Apply** is the single thing that navigates to the employer's page, which is also where the extension picks the job up (by matching the tab's URL against `source_url`). That means the tailored résumé, cover letter, and any job-specific answers already prepared in the main app are the ones the agent uses.

**It's an orchestrator, not one big prompt.** The extension holds a structured application state and works down a resolution order — job-specific answers, then the answer bank, then deterministic profile facts, then the prepared documents, then ask the candidate. Everything above "ask" is a lookup; no model call is ever spent deciding that a first name goes in the first-name field, and there is no automatic model pass over whatever's left — a narrative field is only ever drafted on the candidate's own request (see Generate below). It fills one field at a time so the candidate can watch, **verifies each value against the live DOM** before counting it (forms reformat, reject, and silently revert values), **re-reads the page** after each pass because answering one question routinely reveals another, and finishes with a review pass for required-but-blank fields, validation errors, and fills that didn't stick. The model never touches the DOM: the agent may only take actions from a fixed tool set that deterministic code executes.

`POST /applications/match` is the resolver behind the lookup tiers, and stays the single place the profile is needed for this pass. Resolution runs cheapest and most trustworthy first: job-scoped answers, then the answer bank by normalized `questionKey()`, then contact facts parsed deterministically from the profile label and the tailored résumé's `contact_line` (StructuredProfile models career history, not contact details). **Anything unresolved comes back as `missing` rather than guessed or drafted**, each entry carrying a `reason` (`sensitive` or `open`), the field's real `options` straight off the employer's form (never invented — a radio or select with no reliable options comes back with an empty list rather than a synthesized `["Yes","No"]`), a `category` from `classifyAnswer` (for anything not sensitive), and `can_generate`, which is true only for a `text`/`textarea` field that isn't sensitive — a date, number, select, or radio field only ever gets a real value: the employer's own options, or what the candidate types, never a fabricated date or number.

**Three actions replace the old "fill and remember" ambiguity: Generate, Fill, Save.** For an open-ended field `can_generate` allows drafting, the sidebar offers **Generate**, which calls `POST /applications/generate-answer` for a single focused draft grounded in the candidate's structured profile, resume history, the job description and company, job-specific review evidence (`candidate_evidence` with `category = 'job_review'`), and any existing saved answers — never fabricating experience, credentials, dates, or employers. The draft lands in the sidebar's own editable textarea and is never written to the employer's form directly: **Generate → review/edit → Fill or Save**. The prompt itself is Langfuse-managed (`applications/generate_answer`, see "Prompt Management" below), not hardcoded, so its instructions can be revised without a deploy; `NEVER_INFER` is checked again server-side before any draft is attempted, not just trusted from the sidebar's own gating. **Fill** uses the candidate's answer (typed or drafted-then-edited) on this application only — no backend write beyond the audit event. **Save** does that and also remembers it, scoped by `POST /applications/answer`'s classification (below); the sidebar shows the resulting category-and-scope-aware confirmation (e.g. "Filled and saved for future Anthropic applications.") rather than a generic "saved."

**Not every answer is worth remembering, and Save is itself the "remember this" signal.** `POST /applications/answer` classifies what the candidate types (`classifyAnswer`) before deciding where it goes: stable facts and standing preferences into the durable bank; salary/notice-period/start-date into the bank but marked `contextual` because they go stale; "why do you want to work here" against that job only, in `job_application_answers`, so it can never leak into an unrelated company's application; agree-to-terms and referral-source nowhere at all, and the endpoint says so honestly rather than claiming something was saved. Since the candidate only ever calls this endpoint by clicking Save, an otherwise-ambiguous classification resolves straight into the bank instead of asking a second time. The classification is rule-based on purpose — it runs on every answered field, and mis-filing personal data is the kind of decision that should be inspectable in a regex rather than re-litigated by a model each time.

**Contradictions are surfaced, not silently resolved.** If the new answer disagrees with a saved one, the endpoint returns the conflict instead of writing, and the agent asks — "Update the saved answer" or "Just this once." The candidate's current answer always governs the application in front of them; the stored copy only changes with an explicit `confirm_overwrite`.

**The agent's decisions are logged.** `POST /applications/events` writes to `application_agent_events` (migration `0022`): which tier answered a field, whether the value stuck, what the candidate was asked, what got stored, contradictions, the final review. Values are dropped for anything `NEVER_INFER` matches — that a work-authorization question was asked and answered is the useful signal; storing the answer a second time outside the bank is not.

**`NEVER_INFER` fields skip the model entirely — no autofill, no Generate.** Work authorization, sponsorship, citizenship, veteran status, disability, gender, race, criminal history, salary, notice period, start date, relocation, and security clearance are legally or personally consequential, and a confident guess is worse than no answer. Either the bank already holds an explicit answer the candidate gave before, or the candidate is asked directly; the sidebar never shows a Generate button for these, and `POST /applications/generate-answer` re-checks the same regex server-side rather than trusting that gating. The regex is stem-based (`disab\w*`, `relocat\w*`) because word-boundary matching silently missed "disability" and "relocate"; `scratchpad/ui/assert_never_infer.mjs` reads the pattern straight out of the source and checks 27 real question phrasings against it so the two cannot drift apart.

**Auth reuses the existing device sessions.** `requireSession` accepts `Authorization: Bearer` alongside the cookie, hashed against the same `device_sessions` table, and the extension enrolls through the ordinary one-time-code flow (`return_token: true` on `POST /auth/enroll` hands back the raw token, which the caller already receives via `Set-Cookie` anyway). So the extension shows up in the Devices tab and is revoked like any other device, with no second credential system to outlive a revoke. CORS is scoped to the handful of paths the extension calls and **never allows credentials**, which keeps cookie auth strictly same-origin: a cross-origin caller must present a bearer token, and only the enrolled extension has one.

Authenticated data endpoints:

- `GET /profile` / `PUT /profile` — `PUT` only updates `label` (name) now. Response includes `desired_roles` (from `preferences_json`) and `structured` (parsed `structured_json`, or `null` if nothing generated yet). The first `candidate_profiles` row is created on first use (by any tab) and updated in place after that.
- `PUT /profile/structured` — saves an approved structured-profile draft (`{"structured": {...}}`) into `structured_json`, and mirrors `narrative_summary` into the legacy `summary` column.
- `GET /role-signals` / `POST /role-signals` / `DELETE /role-signals/:id` — freeform `candidate_evidence` rows (`category = 'role_signal'`)
- `PUT /desired-roles` — saves the reviewed description into `preferences_json.desired_roles`
- `POST /resumes/master` — **retired from the primary UI.** The canonical career record is now the structured `CareerProfile` (Profile → Summary), not an oversized resume; a resume is presentation, and using one as the evidence database was what made it impossible to hold evidence a resume would never show. The endpoint and existing `is_master` rows are deliberately left in place for backward compatibility, but nothing generates or reads them in the normal workflow, and the Resume tab filters them out.
- `POST /desired-roles/generate` — synthesizes a structured "roles you're looking for" description (still prose) from all role-signal notes, via Anthropic or OpenAI. Draft only, not auto-saved. This is the filter that decides which postings are worth showing at all, so it's explicitly told not to conglomerate genuinely different role paths into one synthesized hybrid: a former teacher's notes about wanting ML engineering, advocacy, and corporate training roles should come back as three separate entries, not one blended "ML advocate and trainer" role that doesn't exist in the job market. Both the tier-1 screen and tier-2 fit-scoring prompts (`fit.ts`) are told the same thing on the consuming side — a posting only has to be a strong match for ONE listed entry to be on-target, not all of them at once — so a candidate open to several different fields isn't penalized for a posting that's a great fit for one path but silent on the others.
- `GET /jobs` / `POST /jobs` / `DELETE /jobs/:id` — `job_postings` rows (`title`, `company`, `source_url`, `raw_description`)
- `GET /documents` / `POST /documents` / `PATCH /documents/:id` / `DELETE /documents/:id` — `source_documents` rows backed by private R2 storage. Uploads accept PDF, plain text, or Markdown (15 MB limit, same as `/artifacts`). Text is extracted automatically for all three types: `text/plain`/`text/markdown` read directly, PDFs parsed with [`unpdf`](https://github.com/unjs/unpdf) (Cloudflare's own recommended edge-compatible PDF.js build — see [R2's PDF summarization tutorial](https://developers.cloudflare.com/r2/tutorials/summarize-pdf/)).
- `GET /documents/:id/file` (and `GET /artifacts/:key`) — streams the original file back with its real content-type and `Content-Disposition: inline`, so the dashboard's document name links open a browser-native preview (PDF viewer, plain text) in a new tab instead of forcing a download. Honors HTTP Range requests (`206 Partial Content` + `Content-Range`) — several PDF viewers, notably Adobe's browser plugin, fetch large PDFs in chunks and fail outright ("Failed to load PDF document") without that.
- `GET /notes` / `POST /notes` / `DELETE /notes/:id` — freeform `candidate_evidence` rows (`category = 'note'`) for unstructured facts about yourself, no file needed
- `POST /profile/generate` — synthesizes the canonical **`CareerProfile`** (see [`src/profile.ts`](src/profile.ts)) — identity, career summary, work experience with per-role projects/achievements/mentoring/stakeholder work, education with projects and research, independent projects, publications, evidence-backed skill rollups, career signals and evidence gaps — from all notes and extracted document text (including parsed PDFs), using either Anthropic or OpenAI (`{"provider": "anthropic" | "openai"}`). Reliable JSON is enforced per-provider: Anthropic via forced tool-use with a JSON Schema, OpenAI via `response_format: {"type": "json_object"}`. Returns a draft only; it is never auto-saved. The dashboard shows it for review and only writes it via `PUT /profile/structured` once you click "Save this" — consistent with this project's human-supervised design (see `docs/product/progressive-autonomy.md`). The intent: this structured record is what later features (auto-filling applications, per-job tailoring) read from, instead of re-parsing unstructured text on every use.
  - **Regenerating is additive, not destructive.** The profile is meant to accumulate over time as you add material, not get overwritten from scratch on every regeneration. The prompt is given the current saved profile as an explicit baseline ("keep every entry the new material doesn't contradict") rather than as just one more source among equals, and a deterministic merge step (`mergeStructuredProfiles`) runs on the model's output regardless: any existing education/experience entry whose key (school+degree, or company+title) doesn't reappear in the new output is re-added automatically. This means a regeneration can only add or correct entries, never silently drop one just because the model didn't happen to re-mention it.
- `GET /resumes` / `POST /resumes` / `PATCH /resumes/:id` / `DELETE /resumes/:id` — named `resumes` rows, each an independent, never-overwritten version. `POST /resumes` (`{"instructions"?, "provider"?, "template"?: "classic" | "modern" | "compact", "max_pages"?: 1 | 2}`) runs the full pipeline described below. Auto-named from the instructions (or a date) at creation; rename afterward via `PATCH`.
- `POST /resumes/:id/review` (`{"comment"?: string, "provider"?}`) — the design-review loop. Re-renders the version, screenshots it, and has a vision model critique it; applies the resulting layout changes and, when the reviewer says the *writing* is the problem, re-composes the content from verified evidence with its guidance. A user `comment` outranks the model's own opinion. Bumps `revision` in place rather than creating a new named version.
- `GET /resumes/:id/file` — the rendered PDF, same Range-aware inline-preview treatment as `/documents/:id/file`.

### Company discovery and job scanning

**Companies are never AI-scored for "fit," and there is no LLM call anywhere in this section.** A company is worth monitoring purely on operational grounds — does a real, readable job board exist for it — never because a model judged its industry "relevant" to the candidate. A non-tech company that occasionally hires the candidate's target role is monitored exactly like one whose whole business matches it; McDonald's hiring an AI engineer is exactly as worth watching as an AI-native startup doing the same hire. Whether a *specific opening* is actually right for the candidate is a job-level question, judged entirely by the existing Jobs pipeline (see "Job filtering pipeline" below) — Companies exists purely to discover and monitor real employers, not to pre-filter them by how "relevant" their industry sounds.

The pipeline is **Discovery → Verify**, deliberately mirroring the shape of Jobs' own **Pre-screen → Screen → Fit** — the two are meant to feel like one continuous system split across two tabs, with Companies' output (real jobs, freshly scanned off a verified company's board) landing exactly in Jobs' own Pre-screen stage, not a separately-invented one.

- `GET /companies` / `POST /companies` / `PATCH /companies/:id` / `DELETE /companies/:id` — the target-company list. `PATCH` toggles `status` to `dismissed` (a company can be set aside without losing it) or back (restoring whatever verify state its already-known `website`/`ats_provider` implies, not a blind reset — see `updateCompany` in `index.ts`), or — when the body includes a `website` — re-verifies that URL and, on success, sets the row back to `discovered` so the next scan resolves its board fresh. That last form is the manual-fix path for any `unverified` company (see reason codes below): the candidate types in the real address, the same `verifyWebsite()` check discovery itself uses confirms it, and only then does the company become eligible for board resolution again.
- `POST /companies/bulk` (`{"text": string}`) — adds many companies from one pasted list, for a candidate who already has their own list of employers. Deliberately permissive about formatting: text is split on newlines, commas, *and* semicolons together, so "Acme, Beta Corp, Third Co" on one line works exactly the same as three separate lines. Each token also gets a leading bullet/number stripped (`- `, `1.`, `(2)`) and surrounding quotes removed (for a pasted CSV column). A token that looks like a URL or bare domain (`looksLikeUrl()`) attaches as the website of whichever name came right before it rather than becoming its own entry, so "Acme, https://acme.com, Beta Corp" reads as two companies, not three. Capped at 50 parsed companies per call. Reuses `addCompanyRow()`, the same dedup-by-name-key insert every other path into `companies` goes through, so a name already on the list is silently skipped rather than duplicated.
- `POST /companies/discover` (`{"focus"?: string, "page"?: number}`) — **the only discovery mechanism, and deliberately not LLM recall of any kind.** Searches the [Adzuna Job Search API](https://developer.adzuna.com/) (`src/adzuna.ts`) for real, current postings matching the candidate's role vocabulary (`roleTitleTerms()`, the same explicit title/alternate-title/search-term list the board role-filter already uses) crossed with their desired locations, deterministically groups the results by company (`aggregateCompanies()`, keyed by `companyNameKey()` — no LLM call), then attempts to resolve each newly-seen company's real domain (`resolveCompanyDomain()` — see below) before inserting it as `discovered` or `unverified`. Company identity comes straight off Adzuna's structured `company.display_name` field per posting; nothing about *which companies exist* is ever something a model is asked to recall or judge. `page` selects which page of each search query this call reads (default 1) — see "Streaming progress" below for how the frontend advances it across rounds. No `provider`/API key is needed for this endpoint at all; it fails with `501 {"error":"adzuna_not_configured"}` if `ADZUNA_APP_ID`/`ADZUNA_APP_KEY` aren't set.
- **Domain resolution is deterministic too, and follows the same "propose a candidate, code confirms it" split `resolveBoard()` already uses one level down for ATS org slugs.** `resolveCompanyDomain()` (`src/companies.ts`) tries a handful of plausible slugs derived from the company's bare name against `.com`, then `.io`, then `.ai`, confirming each guess with the same `verifyWebsite()` check discovery has always used. The **first** candidate that verifies wins; nothing is ever trusted unconfirmed. A company whose domain can't be guessed this way is inserted anyway, as `status = 'unverified', verify_reason = 'no_website'` — recorded, not discarded, so it stays visible (in the Unverified tab) and the candidate can supply the real website by hand. There is deliberately no LLM fallback for this: an unconfirmed guess is worse than none, since a wrong domain could resolve to some *other* company's real ATS board entirely.
- `POST /companies/scan` (`{"limit"?: 1-500, "company_id"?: string}`) — this is where Verify and the actual job-board read happen, and where jobs actually enter `job_postings` (and therefore Jobs' own Pre-screen). For each eligible company (`status != 'dismissed'` — `discovered` and `unverified` rows are retried every run, not just fresh ones, since a company with no board last time might have one now), resolves its ATS provider/token if not already known (`resolveBoard()`, unchanged — see below), classifies the outcome (`classifyVerification()` in `src/companies.ts`, see reason codes below), and on success reads the board and imports new postings exactly the way it always has. Streams progress as newline-delimited JSON (see "Streaming progress" below) ending in `{"type":"done","scanned","results","new_listings","eligible_total"}`. Driven from both the Companies tab's "Find companies" flow and the Jobs tab's "Find Jobs" flow — company/board scanning is fully shared between the two, not duplicated.

**Verify outcomes and their reason codes** (`classifyVerification()` in `src/companies.ts`, fully unit-tested in `companies.test.ts`): a company is `verified` once it has a confirmed website *and* a job board this app can actually read — nothing less counts, even if the site and a board both technically exist. Anything short of that is `unverified`, with one specific `verify_reason`:

| reason | meaning |
|---|---|
| `no_website` | No domain could be confirmed for this company at all. |
| `no_job_board` | A website was confirmed, but no job board could be found on it. |
| `unsupported_ats` | A job board was found, but it's on a platform this app can't automatically read (ADP, iCIMS, and the rest — see below). |
| `board_unreachable` | A supported board was found, but the very first read of it failed. |

**A company that has already read successfully at least once is never demoted back to `unverified` by a later transient failure** — `board_unreachable` only applies to a company's first-ever read attempt (`classifyVerification`'s `hadPriorSuccess` parameter, driven by whether `last_scanned_at` was already set). Without this, a company with a perfectly good, working board could flip in and out of Verified on nothing but a single flaky network request.

**No aggregators *for job data*, by design — discovery is the one deliberate exception, and only for finding which companies to look at.** Every posting a candidate actually sees still comes from that company's *own* board, never Adzuna or any other third party. Nearly every company runs that board on one of a handful of applicant tracking systems, and eight of them publish plain public JSON APIs this app reads directly: Greenhouse (`boards-api.greenhouse.io`), Lever (`api.lever.co`), Ashby (`api.ashbyhq.com`), SmartRecruiters (`api.smartrecruiters.com`), Workday (`*.myworkdayjobs.com`'s CXS API), Workable (`apply.workable.com`'s own public embed-widget API), Recruitee (`{company}.recruitee.com/api/offers/`, officially documented at docs.recruitee.com), and BambooHR (`{company}.bamboohr.com/careers/list` plus a per-posting `/detail` endpoint for the description and canonical URL, which its thin list omits — the same two-call shape SmartRecruiters already needs). So "check their site directly" is implemented by resolving *which* ATS a company uses and reading that board's API, which is structured and stable, rather than scraping a JavaScript-rendered careers page.

The last three joined the first five after a live investigation of all thirteen previously-detect-only platforms: every claim below is a real HTTP response captured against real companies (three per provider that ended up readable), not a vendor's documentation taken on faith. Paylocity is the cautionary case that investigation surfaced — its feed API responds `200` with well-formed JSON and *looks* just as usable, but returned an empty `jobs` array for every one of five different real, currently-recruiting companies tested. That is precisely the "looks like it works, silently returns nothing" failure mode the next paragraph warns about, so it stays detect-only rather than shipped on a guess a live test could not actually confirm.

**Ten more platforms are recognized without being auto-read.** ADP, iCIMS, JazzHR, Breezy, Personio, Paylocity, UKG/UltiPro, SAP SuccessFactors, Oracle Taleo, and Jobvite are all detected by their careers-link URL pattern (`ATS_PATTERNS`/`isReadableAtsProvider` in `src/companies.ts`), but each was checked and found to have no reliable public, unauthenticated, multi-tenant path: ADP and iCIMS render their career sites client-side from an internal call this investigation could not locate; JazzHR gates its feed per customer with an API key, and Jobvite's feed exists but is opt-in per customer and usually left off; Breezy's public API requires a bearer token; Personio has a real, confirmed-live feed, but it's XML rather than JSON, which every reader in this file is currently built around — a scoped follow-up, not a dead end; and UKG, SuccessFactors, and Taleo each have some public-but-undocumented surface that additionally needs a company-specific ID (a data-center host, a portal ID, a company code) discoverable only by inspecting that one company's own page, beyond what a regex over a careers-page link can extract. Recognizing the platform is still real progress over silence: a company using one of these gets `ats_provider` set to the platform's name, `careers_url` updated to the *actual* board link found (rendered as a "View job board ↗" link on the Companies tab), and a scan note reading "Uses ADP for hiring. View current openings directly." instead of the old, misleading "No supported job board found on their site." — which read as "nothing exists here" when something very much did, the candidate just had to go find it by hand. Guessing a JSON shape for these with no way to verify it against a live response is how you ship code that silently returns nothing while looking like it works, so the honest move is detection plus a working link, not a parser nobody can check.

**Board resolution tries four things, in order, cheapest and most-likely-correct first** (`resolveBoard()` in `src/companies.ts`):

1. **Read the homepage itself.** It's fetched anyway for step 2, so checking it directly for an ATS pattern first is free — and it catches a company whose board link sits right on the front page with no separate careers page at all.
2. **Follow an actual "Careers" link the site publishes.** `extractCareersLinks()` pulls every `<a>` off the homepage whose href or visible text hints at careers/jobs/hiring/"join us"/"work with us", ranks the ones matching on *both* highest, and tries the LLM-proposed `careers_url` first, then those, in order. This is what a person actually does — open the homepage, find the button that says "Careers", click it — rather than only ever guessing a fixed list of common URL paths, and it's what makes a case like Advantest's actual careers page (which lives at an unguessable path and hands off to ADP through a "you are now leaving our site" interstitial) resolve correctly: the interstitial page gets fetched and read for an ATS pattern exactly like any other page reached this way.
3. **Fall back to a fixed list of common careers paths** (`/careers`, `/jobs`, `/join-us`, ...), for a site whose real link steps 1-2 missed.
4. **Last resort: guess plausible org slugs** (from the domain and the company's name) against Greenhouse, Lever, Ashby, SmartRecruiters, and Workable directly — for a careers page that renders its board client-side and never puts the real link in the static HTML at all. Recruitee and BambooHR are read once found via steps 1-3, but deliberately not guessed here yet — see the comment on this loop in `resolveBoard()` for why.

A company where none of the four find anything is marked `ats_provider = 'none'` with a note, so it isn't retried blindly.

**No provider puts a whole posting in one field, and assuming otherwise is what made every "what do you care about" fact come back "Not specified".** The scoring model was never the problem — it was answering honestly about text it had never been given. Each provider needs its own assembly (`joinSections` in `src/companies.ts` concatenates whichever sections exist and drops the rest, so a renamed or removed field degrades to a thinner posting instead of an empty one):

- **Lever** splits a posting across `description` (the opening paragraph *only*), `lists[]` (the responsibilities and requirements bullets), and `additional` (the closing block, which is where a Lever posting almost always states pay). Reading `description` alone — which is what the code did — captured the intro and discarded the entire rest of the posting. A real Osaro listing stating "$100,000 - $140,000 a year" and "5+ years of experience" was stored as one sentence: *"Osaro builds machine learning software for robots."* Nothing downstream could recover what was never captured, which is why widening length caps had no effect on it.
- **Greenhouse** does return the whole posting in `content`, but **entity-escaped** (`&lt;p&gt;`, not `<p>`). The old `stripHtml` stripped tags *before* decoding entities, so the strip was a no-op and the decode then turned every `&lt;`/`&gt;` into a literal angle bracket — leaving `<p>`, `</strong>`, `</div>` in the stored text as visible noise, padding the description against its length cap and burying the real sentences. `htmlToText` decodes first, then strips, then decodes again (for content that was double-escaped, common for `&amp;`).
- **Ashby** publishes a pay range in `compensationTierSummary`, separate from the description prose, so it's read explicitly rather than hoping it also appears in the body.
- **SmartRecruiters**' `/postings` list carries **no description at all**, and **Workday**'s CXS listing endpoint is the same — title and location only. Those postings previously reached tier-2 scoring with an empty description — judged on title alone, and structurally unable to report a salary or years figure however clearly the real posting stated one. `fetchMissingDescriptions()` fills them from a per-posting detail endpoint (SmartRecruiters' `jobAd.sections`; Workday's `jobPostingInfo.jobDescription`, fetched from the same tenant/pod/site the listing came from plus the posting's own `externalPath`), called on the *filtered* set after role/location matching so a request is never spent on a posting already ruled out, and bounded by both the shared scan budget and a per-company cap.

`scratchpad/ui/assert_board_parsing.mjs` locks all of this down: it runs the real `fetchBoardJobs`/`fetchMissingDescriptions` against a realistic payload per provider and asserts a stated salary and years-of-experience figure survive into the parsed description, plus that no raw markup does. It fails against the pre-fix parser for Lever and Greenhouse, which is the point — this class of bug is invisible from the UI (the facts just say "Not specified", exactly as they would for a posting that genuinely omits them) and needs a test at the parse boundary to catch.

**`status = 'reachable'`/`'unreachable'`/`'unresolved'` are now purely historical values, from before this pipeline had explicit Discovery/Verify stages.** Migration `0027_companies_verify_pipeline.sql` backfilled every existing row into the current `discovered`/`verified`/`unverified`/`dismissed` model on deploy (see that file for the exact mapping); nothing in the app writes the old values any more. `unverified` rows (of any reason) are *not* excluded from routine scanning the way the old `unreachable`/`unresolved` were -- a company with no board last run might have one now, or a temporarily-unreachable one might read fine on retry, so there's no reason to permanently give up on it.

Scanning is **batched against a shared subrequest budget** (each company costs a few outbound requests, and Workers cap subrequests per invocation), and the companies in a batch are **scanned concurrently, not one after another** — reading a board is a plain fetch with no LLM cost, so there's no reason for company #40 to wait on company #1 to finish first. `runPooled()` (`src/index.ts`) runs up to 8 companies at once, which is what turns "several minutes across multiple rounds" into "under a minute in one click" for a realistic company list: this used to require staying on the page to click "Scan company boards" again and again as each round finished, and a closed tab meant the remaining companies just sat unscanned until the page was reopened. The endpoint still reports how many companies remain unscanned in case the list is larger than one round's budget covers, but for the common case (dozens to a couple hundred companies) one click now clears the whole thing. Re-scanning is safe: a partial unique index on `(company_id, external_id)` makes posting inserts idempotent, and it's partial so manually added jobs — which have neither — are never caught by it. Scanned postings are filtered against your Desired Roles by title keyword, a deterministic pass that needs no model call.

**Location is a hard filter, enforced twice.** `candidate_profiles.preferences_json.desired_locations` (set on the Desired Roles tab) states where you'll actually work. Discovery passes it to Adzuna as a `where` search parameter *and* re-checks every result against it in code on the way in (`locationMatches()`), because a soft filter on an external API is still worth enforcing locally rather than trusted blindly. Board scans apply the same check per posting, not per company — a company can qualify on location while most of its openings don't. Matching understands state abbreviations both ways (`CA` ↔ `California`) and common metro shorthand (`Bay Area`, `SoCal`, `NYC`), treats remote as always acceptable, and lets postings with no stated location through rather than dropping real results. Companies added before a location was set are flagged in the list instead of deleted, so tightening the filter never silently discards work.

**Known limitations of the Adzuna-backed discovery path**, worth keeping in mind rather than treating the pipeline as flawless: (1) **staffing/recruiting-agency noise** — a job aggregator sometimes lists the placing agency, not the actual employer, as the posting's `company`, which can put a staffing firm's board on the candidate's watch list instead of the real one; there's no denylist for this in the current build, since it needs validating against real response data first. (2) **Adzuna is queried per-country** (`ADZUNA_COUNTRY`, default `us`) — a candidate targeting locations outside that country gets zero discovery results with no error, only a status line that reads like nothing was found. (3) **Rate limits** — Adzuna's free tier is modest, which is why `discoverCompanies`'s query-pair fan-out runs at `runPooled` concurrency 2, deliberately lower than the 6-8 used elsewhere in this file for plain (non-rate-limited) fetches. (4) Discovery only ever sees what's *currently* posted — a company that hires this kind of role often but has nothing open at query time can still be missed on any single run, which regular re-runs (the primary flow is meant to be clicked again, not just once) mitigate but don't eliminate. There is deliberately no LLM-recall fallback for any of this -- see the top of this section for why.

### Job filtering pipeline

Finding listings is cheap; judging them is not. The naive version — send every scraped posting to a strong model alongside the full profile — is the expensive way to do this, so the work is split into tiers that get progressively more costly and progressively fewer inputs:

| tier | what runs | cost | input per posting |
|---|---|---|---|
| 0 | location match + title keyword, in code | free | — |
| 1 | cheap model, binary keep/drop, 60 postings per call | low | title, location only |
| 2 | strong model, 0-100 fit score + reason + gaps, 8 per call | high | full stored description |

Two things make this work. **Scanning no longer judges anything** — `POST /companies/scan` only collects listings, so it stays fast and covers more companies per request. **`POST /jobs/process`** then runs tier 1 and tier 2 in that order against a shared call budget, reporting what remains at each stage so the dashboard just asks again. One "Find my matches" button drives the whole thing.

**Within a tier, every batch this round's budget can afford is fetched and fired at once, not one batch at a time.** The batches don't depend on each other (only tier 2 as a whole depends on tier 1 finishing first, since it reads tier 1's survivors), so there's no reason to wait for screen-batch #1's model call to return before starting screen-batch #2. `processJobs` fetches all eligible postings for the round up front, splits them into disjoint `SCREEN_BATCH_SIZE`/`FIT_BATCH_SIZE` chunks so concurrent calls never see overlapping rows, and runs up to 8 of those chunks at once through the same `runPooled()` helper `POST /companies/scan` uses. The per-call budget was raised from 12 to 24 alongside this, since firing calls concurrently rather than sequentially is what makes a bigger per-click budget actually usable in a reasonable amount of time.

**The Search tab shows this as a small animated sankey, not a text line.** The old summary line ("5 matches · 40 waiting to be filtered · 418 dropped in screening · 158 ruled out") stated the same four numbers the pipeline already computed, but as a sentence rather than a shape — reading where a posting currently sits meant parsing the sentence, not seeing it. `renderJobPipeline` (`src/index.ts`) still builds that exact sentence, but now as a screen-reader-only summary (`#jobs-pipeline-summary`, `aria-live="polite"`); the visible `#jobs-pipeline` element (`aria-hidden`, since the sr-only text is the accessible version) is an inline SVG built by `pfBuildSvg`.

The shape has two real branch points, not a generic n-level sankey, so the layout is hand-computed rather than run through a general sankey-layout algorithm: `pfFlowData` derives a root ("all scanned postings"), col1 (what the cheap screen did with them: not screened yet / screened out / passed screening), and col2 (what the detailed pass did with whatever passed: still awaiting review / matched / ruled out) directly from the same counts `jobPipelineCounts` already returns. `pfLayout` positions every node along a single "main axis" independent of orientation, and a link's ribbon tapers between a source thickness (a proportional slice of the parent's own rendered length, so sibling ribbons exactly tile the parent) and a target thickness (the child's own bar length, scaled separately since a column with more nodes has more gap overhead) -- ribbons that aren't a constant width end to end is normal sankey behavior, not a bug.

**Orientation follows the container, not the viewport.** Below 480px of actual measured width (`host.clientWidth`, re-measured on resize and again the first time the Search tab is actually clicked -- it isn't the active panel on load, so the very first render would otherwise measure a hidden, zero-width container) the diagram stacks top-to-bottom, one row per pipeline stage, bars sized by width; at or above that it lays out left-to-right, columns by stage, bars sized by height. A phone's actual content width sits well under the threshold; a laptop's Search tab (never split into two columns, unlike most of this dashboard) comfortably clears it, capped at 640px so it doesn't stretch thin across a very wide window.

**Every label gets a solid background halo and is clamped to stay inside the diagram.** Labels sit right next to -- sometimes over -- a ribbon curve in a diagram this compact, so a halo (`pfLabelHalo`) keeps them legible regardless of what's underneath, rather than hand-tuning every position to avoid overlap. Separately, at an extreme value split (a 1-vs-999 imbalance is a realistic early state -- almost everything still needs screening), a node's bar can be a sliver sitting right at the diagram's edge; a label centered on that sliver would extend past the edge and clip. `pfLabelText`'s `clampBounds` nudges the label's anchor coordinate inward by half its own estimated text width before drawing it, so it always stays fully inside the viewBox -- per the same "measure first, a label never gets clipped" principle applied everywhere else labels are drawn in this app.

**The flow direction is shown with small dots animated along each ribbon's centerline** (SVG `animateMotion` against an invisible `<mpath>` companion path, two dots per ribbon staggered half a cycle apart), not just a static colored shape -- colors are otherwise reserved for status (green matches, amber pending/awaiting, red screened-out/ruled-out, muted gray for the two structural nodes that aren't an outcome), matching the badges used everywhere else in the dashboard. `prefers-reduced-motion: reduce` hides the dots entirely via CSS; the ribbons and labels alone still convey the data.

### Streaming progress

Both `POST /companies/scan` and `POST /jobs/process` can process hundreds of items in a single call, so both stream progress rather than making the user stare at a static "please wait" until everything finishes. The response body is newline-delimited JSON (`ndjsonResponse` in `src/index.ts`): one `{"type":"progress",...}` line per unit of work as it completes (per company scanned; per screen or assess batch), ending in one `{"type":"done",...}` line with the same summary the endpoint used to return outright, or `{"type":"error","message"}` if something failed mid-stream.

The response starts streaming immediately — the handler's async work runs via `ctx.waitUntil()` after the `Response` (wrapping a `TransformStream`) is already returned, so the client sees the first progress line without waiting for the whole operation. The dashboard's `readNdjson()` helper reads the body with a `ReadableStreamDefaultReader`, splits on newlines (buffering a partial line across chunk boundaries), and updates the status text on every line — "Step 1 of 2 — quick screen: 75 of 243", "Scanning… 2 of 6 companies (Applied Intuition)". The screen/assess labels spell out "Step 1 of 2"/"Step 2 of 2" explicitly rather than just naming the stage ("Screening…"/"Assessing…") — voice feedback was that the pipeline reads as one undifferentiated pass without that framing, since both stages share the same progress line and status element.

Progress here is a reporting layer, not a resilience mechanism in itself — the actual data safety comes from each unit of work being written to D1 *before* its progress line is emitted (already true of both loops: a company's listings are inserted, then its progress line goes out; a screen/assess batch is written, then its progress line goes out). So if the connection drops or the tab closes mid-stream, whatever was already written stays written — resuming is just clicking the button again, same as before this streamed at all. Now that companies and batches run concurrently rather than one at a time, progress lines arrive in *completion* order rather than list order (company #6 can finish before company #2), which doesn't change any of this — each line still only goes out after its own write lands, whichever one happens to finish first.

The cheap tier is deliberately **biased toward keeping**: it exists to remove obvious misses, and a wrong drop there is invisible to the user, so anything ambiguous survives to tier 2. Postings the model doesn't return a result for are also kept. Screened-out postings stay in the database rather than being deleted, so a re-scan never re-pays to reject them.

**Tier 1 judges on title and location alone, with no description.** A different profession or field (a mechanical/hardware role against a software profile) or a wildly off seniority word ("Staff"/"Director" vs. "Intern"/"Entry-Level") is obvious from the title, and dropping the description shrinks the per-posting prompt cost enough to raise the batch size (25 → 60 postings per call) for the same cost. Anything the title alone can't rule out — a stated years-of-experience minimum, a specific required tool, anything else that only shows up in the body — survives to tier 2, which reads the full description and can still catch it there.

`fit_status` is the pipeline's state machine: `unassessed` → `screened_out` | `screened_in` → `strong` | `possible` | `reject`. The Jobs tab shows matches and anything still queued, and hides only what a filter actually ruled out. Since tier 2 (below), `fit_status` for a scored posting is *derived* from its `fit_score` via `verdictForScore()` in `src/fit.ts` — the number is what's actually computed and stored; the bucket exists only so the rest of the pipeline's hide/show/sort logic doesn't need to know about scores.

**`interested` is a manual override on top of that state machine, the same way a user rejection already is.** `PATCH /jobs/:id/fit` gained two actions: `interested` sets `fit_status = 'interested'` and stamps `interested_at`, *without* touching `fit_score`/`fit_reason` — the score and reason that made it worth pursuing stay intact for the Interested tab to show. `uninterested` reverses it without the data loss a full `restore` would cause: it sets `fit_status` back to whatever `verdictForScore(fit_score)` already implies (or `unassessed` if it was never scored), rather than unconditionally wiping the score the way `restore` does. A posting with `fit_status = 'interested'` is excluded from all three of the Jobs tab's buckets (matches/queued/ruled-out) — it only appears on the Interested tab.

**`GET /jobs` returns every posting, uncapped.** It used to `LIMIT 300`, which was harmless while the table was small but started silently disagreeing with the dashboard's own pipeline summary once it wasn't: that summary counts every row in `job_postings` regardless of the cap, so a posting could be counted as a match up top while never actually reaching the browser to render, because it happened to sort outside the first 300 rows by post date. The fix is to just not cap it -- the two numbers can't drift apart if they're computed from the same set. This is safe to do because the query also stopped selecting `raw_description`, which the Jobs tab never displays (only `fit_reason` and `fit_missing_json` do) and which at up to 1500 characters per row was the actual weight in that response.

**Scanning all of a large company list is one click, not many.** The `limit` a scan request asks for barely matters for cost — the real governor is the fetch budget inside the loop, which already stops early and reports what's left regardless of how high `limit` goes. Both "Find Jobs" (Jobs tab) and "Find companies" (Companies tab) always request `limit: 500` and let the frontend re-fire the request on its own (capped at 25 rounds, as a backstop against a real server problem looping forever) until `eligible_total` is covered, rather than exposing a "how many to scan" choice in the UI at all — there's nothing a smaller number would actually save, since the fetch budget is what bounds real cost either way.

**There is no "already scanned today" exclusion.** `POST /companies/scan`'s target query considers every eligible company on every call — a company re-read minutes ago is just as much a candidate as one that's never been read, and a click of Find Jobs/Find companies always re-reads everyone's board regardless of when it was last checked. This is deliberate: a board read is a plain fetch with no LLM cost, so there's no real budget reason to skip it, and it means a change to what gets *captured* from a posting (a description-cap widening, say) takes effect on the very next click rather than needing a special re-scan mode. Ordering by least-recently-scanned first (`ORDER BY last_scanned_at IS NOT NULL, last_scanned_at ASC`) is still what matters when the fetch budget can't reach every company in one request: each round's just-scanned companies get a fresh `last_scanned_at` and sort to the back, so a multi-round run still ends up covering every company exactly once before repeating any of them.

**The compact match profile.** `candidate_profiles.match_profile` is a short rendering of the profile — headline, summary, roles, degrees, skills — capped at 2000 characters, and it is the candidate half of every screening call. It's built **deterministically** from `structured_json` rather than generated by a model: it costs nothing, is identical on every run, and cannot drift out of sync with the profile it describes the way a cached LLM summary would. The full structured profile runs several thousand characters and would otherwise be re-sent with every batch, which is exactly the input worth shrinking.

Model tiers are configured per provider — `ANTHROPIC_SCREEN_MODEL` (default `claude-haiku-4-5-20251001`) and `OPENAI_SCREEN_MODEL` (default `gpt-4o-mini`) for tier 1, `ANTHROPIC_MODEL` / `OPENAI_MODEL` for tier 2.

### Writing style rules

`WRITING_STYLE_RULES` in `src/llm.ts` is a single shared prompt block imported by every prompt whose output a human actually reads: résumé composition and design review (`src/resume.ts`), cover letters, the Assistant's question, desired-roles drafting, profile generation, and résumé base selection (`src/index.ts`), fit reasons (`src/fit.ts`), and company bios (`src/companies.ts`).

Its main job is banning the **em dash (—) and en dash (–)**, which is the single most recognizable tell that text was machine-written. A résumé that reads as AI-generated is worse than one that reads as merely plain. Ordinary hyphens inside real compound terms are explicitly *kept* ("full-stack", "end-to-end", "data-driven") because that is how those words are spelled, and stripping the hyphen would look wrong to a recruiter rather than natural. The block also names the specific filler phrases that show up most ("delve", "leverage" as a verb, "robust", "seamless", "passionate about") — not an exhaustive list, just enough to push the register away from them — and asks for varied sentence structure and no exclamation marks. The résumé and cover-letter prompts layer an additional formality instruction on top, since those two documents are the ones an employer actually sees.

**The cheap screen tier deliberately gets only the dash rule, not the whole block.** Its entire output is an eight-word fragment, and it runs at the highest volume of anything in the app (60 postings per call, many calls per session), so the rest of the guidance would be prompt cost buying nothing. Two prompts that feed *back into* composition — the design reviewer's `content_guidance` and `decideResumeBase`'s tailoring notes — do get the full block, because guidance written in the banned style reintroduces exactly what the résumé rules strip out.

Storage is bounded on the way in: scraped descriptions are capped at 8000 characters, matching `DESCRIPTION_CAP` in `fetchBoardJobs` (`src/companies.ts`) -- the actual source-of-truth ceiling, since storage or a later prompt can never work with more than what scraping itself kept. Descriptions are the largest column in the database, and the Data tab reports exactly how much space they take.

**A too-tight description cap silently starved the "what do you care about" facts, at more than one layer.** Compensation, remote/onsite policy, hours, and travel routinely sit in their own section at the very *end* of a real posting (a "Compensation and Benefits" block after an intro, a full responsibilities list, a full requirements list, preferred quals, and an "about the company" paragraph) -- for a substantial listing that can easily run several thousand characters before compensation is even reached. Three caps had to move together, at the same value, since the tightest one anywhere in the chain determines what the model actually receives: `DESCRIPTION_CAP` in `fetchBoardJobs` (the scrape itself, `src/companies.ts` -- the true ceiling, previously 4000, and before that effectively 1500 since storage cut it down further anyway), the storage cap in `scanCompanies`'s insert (`src/index.ts`, was 1500), and `fitPrompt`'s own per-job slice (`src/fit.ts`, was also 1500). All three are 8000 now -- generous enough that no real single-role posting should hit it, chosen with room to spare rather than tuned to exactly one observed posting's length. A posting already on file from before this fix stays stuck at its old truncated text forever otherwise -- `POST /companies/scan`'s insert loop backfills it: when a posting's `(company_id, external_id)` already exists (an `INSERT OR IGNORE` no-op), a follow-up `UPDATE ... WHERE LENGTH(raw_description) < LENGTH(?)` replaces the stored description only if the freshly scraped one is actually longer, so a plain re-scan is enough to pick up the fuller text -- no need to delete and re-add anything. Re-running "Re-check my top matches" afterward re-scores against the now-complete description.

**`GET /` had no `cache-control` header at all.** Every other private response in this Worker sets `private, no-store` explicitly; the dashboard route (`dashboardPage()`) was the one exception, left to whatever default caching heuristic a browser or intermediate cache applies to a bare HTML response. Since the entire dashboard -- markup, CSS, and JS -- is one inline page with no separately-versioned asset URLs, a cached copy of this one response is a cached copy of the whole app, including whatever bug fixes already shipped to `main`. Now explicit, matching the rest of the app.

### Stored data and stage resets

The **Data** tab shows what's actually stored — row counts per collection, and byte totals for the two bulky text columns — and lets a developer reset the pipeline at any stage.

Stages are ordered, and resetting one clears **everything downstream of it**, because those results were derived from what's being removed: companies → listings → descriptions → screening/assessment. Resetting job descriptions, for example, also clears every fit verdict, since those verdicts were computed against descriptions that no longer exist. Each button states its downstream effect before confirming.

Hand-added postings are deliberately exempt from the listings reset (they have no `company_id` and are the user's own work), and are deletable separately alongside other standalone collections — rejection reasons, resumes, notes, role signals.

### Job fit assessment (tier 2)

The strong-model pass, run only on postings that survive screening (`src/fit.ts`). Rather than picking a label directly, the model rates each posting **0-100** and a fixed function (`verdictForScore`) buckets that into `strong` (≥70), `possible` (40-69), or `reject` (<40) for the parts of the app that only need the bucket. The score itself is what's stored and shown, so the Jobs tab can offer a real threshold instead of three fixed buckets — see the "Minimum score" filter there.

`job_postings.assessed_at` has been stamped every time a posting is actually judged since tier 2 first existed (`0006_job_fit.sql`) — both on a real score (`storeFitResults`) and on a manual "Not for me" — even though nothing surfaced it until the Jobs tab's "Sort by → Recently processed" option (`listJobs` now selects it, `jobSortComparator('processed')` sorts on it). A posting still `unassessed` or `screened_in` has no `assessed_at` yet and sorts to the end rather than jumping to the top under a naive missing-value comparison — the same "don't penalize missing data" rule `withinAge`/`withinScore` already apply when filtering.

Scoring is calibrated so a single stated hard disqualifier (a language/tool with no evidence, a degree not held, a years-of-experience gap beyond the concrete rule below) caps the score low — 0-14 — regardless of how strong the rest of the overlap looks; a model isn't allowed to average a hard disqualifier away with an otherwise-good match. Every score comes with a one-sentence reason grounded in the specific requirement and the specific profile (mis)match, plus a list of concrete gaps. **Fails open**: a batch that errors, or a posting the model doesn't return, keeps its previous status and stays visible rather than silently disappearing; a posting the model returns nothing for defaults to 50 (the middle of the "possible" band), the same fail-open point the old three-way verdict used.

**The required-years figure is stated plainly in the reason, not just silently weighed into the score.** The whole point of scanning a list of postings is to avoid opening each one, and a candidate who has to click through anyway just to find "5+ years required" defeats that. `fitPrompt` (`src/fit.ts`) now explicitly instructs the model to say so in `reason` itself whenever a posting states a required (not preferred) years figure — "Requires 5+ years; you have about 3, a real stretch" rather than leaving it implicit in the score.

**Dealbreakers are a free-text field the candidate writes themselves, not a fixed rule in the prompt.** There's already a built-in numeric years-of-experience gap rule (`experienceGapRule`, allows up to a 2-year gap as a normal stretch) that stays as the default for anyone who never customizes anything. But what actually counts as a dealbreaker — a tighter years ceiling, a specific tech stack, anything — is personal, and shouldn't require editing the prompt in code to change. `candidate_profiles.preferences_json` gained a key, `dealbreakers` (`readDealbreakers()`/`saveDesiredRoles`, alongside the existing `desired_roles`/`desired_locations`), edited on the Desired Roles tab right next to `desired_locations` since it's the same category of hard constraint. `fitPrompt` inserts it as its own labeled section, enforced with the same weight as a stated hard requirement, additive to (not a replacement for) the built-in numeric rule. Tier 1 (the cheap screen) never sees it — it only has a title and location to judge against, no requirement text to check a dealbreaker against.

**"What do you care about?" is a second, separate free-text field — same candidate-authored pattern as dealbreakers, but purely informational.** Dealbreakers rule postings out; this only decides which quick facts get surfaced per posting (years required, salary, remote/hybrid/onsite, team size, anything — whatever the candidate actually named), and naming a topic here must never move the score. `candidate_profiles.preferences_json.care_about` (`readCareAbout()`/`saveDesiredRoles`) is edited right below Dealbreakers. `FIT_BATCH_SCHEMA`/`FitResult` represent the result as `facts: {label, value}[]` (capped at 8, empty if the candidate hasn't filled the field in) rather than a fixed set of columns, since the whole point is that the app doesn't get to pick the topics — each fact's `value` is the posting's actual stated answer, or `"Not specified"` if it doesn't say one, never estimated.

**The free text is interpreted once into canonical topics, not passed through to each posting.** People write this field the way they'd say it out loud ("remote or hybrid if it says", "like how much percent you have to travel"), and an earlier version handed that raw text to the per-posting scoring call, which dutifully echoed it back as the column heading on every card. Two problems: headings in someone's off-hand phrasing read as unfinished, and nothing pinned the wording down, so the same topic could come back worded differently on two different postings. `deriveCareAboutTopics()` (`src/fit.ts`) resolves the text **once**, on save, into `preferences_json.care_about_topics` — a list of `{label, looking_for}` where `label` is a short clean heading ("Work setup", "Travel") and `looking_for` carries the interpreted intent forward so extraction still knows what was actually being asked about. `fitPrompt` then hands every posting that same fixed list. Because a reworded heading is exactly the failure being prevented, the label isn't left to the model at all: `alignFactsToTopics()` rebuilds each posting's facts from the canonical topics and takes only the *values* from the model output, matching them by label and falling back to position — the same "model proposes, code owns the record" split the rest of `fit.ts` runs on. A topic the model skipped still renders, as `"Not specified"`, so the columns stay aligned across cards.

Deriving is a model call, so it only runs when the text actually changed (editing a location won't re-word the columns), it never fails a save — the pipeline re-derives on its next run via `ensureCareAboutTopics()`, which also backfills profiles whose text predates topics existing — and the derived columns are rendered straight back under the field on the Desired Roles tab, as the same `factChip` the cards use, so what the app understood is visible before any scan runs. Bundled into `job_postings.fit_detail_json` (`0014_fit_detail.sql`) as `{facts: [...]}`, same column the years-required badge used to live in — a shape change, not a new column, since it's a free JSON blob and a posting scored under the old fixed fields just shows no facts until it's re-scored. Both the Jobs tab and the Jindr tab (see below) render whatever facts came back as small **fact chips** (`factChip()`, shared by both) — the label on its own line, the value below it, rather than one `label: value` string squeezed onto a single line. A value that's a full sentence (a stated "onsite only, remote/hybrid not considered" policy, say) needs room to wrap; the single-line pill badge this used to be forced exactly that kind of value into one unbroken line, which pushed the card wider than the screen instead of wrapping. On the Jobs tab, the chips render as their own row below the title/company/location line (`.row-facts`) rather than crowding into it, for the same reason — the number of chips is entirely up to what the candidate asked to see, and a row title line isn't a good place for an unbounded, possibly-multi-line list.

**`POST /jobs/reassess`** (`{"provider"?, "min_score"?: 0-100, default 70}`) re-scores whatever's already sitting at or above a score threshold against the *current* dealbreakers/preferences — for right after editing them, when the postings that mattered most were already judged under the old criteria. Streams progress the same way `POST /jobs/process` does. Only reaches jobs still in the `strong`/`possible` buckets (capped at 300 rows per call as a safety ceiling) — a job already acted on (interested/applied/manually rejected) is a decision already made and isn't silently re-touched. Internally it flips the targeted rows back to `screened_in` and hands them to `assessRowsBatched()`, the same batching/concurrency/storage helper `processJobs`'s own tier-2 pass now uses (factored out specifically so the two never drift apart). Triggered by "Re-check my top matches" right below the Dealbreakers field on the Desired Roles tab.

A manual "Not for me" rejection (no model involved) is stored as `fit_score = 0` — a confirmed non-fit sits at the bottom of the same scale a modeled score would use, so the badge stays meaningful either way.

**Rejections learn, but only from the user, on purpose.** `PATCH /jobs/:id/fit` (`{"action": "reject", "reason"?}` or `{"action": "restore"}`) is what the "Not for me" / "Restore" buttons call. A reason typed here is stored in `job_feedback` and fed into **both** filter tiers as a confirmed disqualifier. The AI's own low score is **not** added to `job_feedback` by itself — only a reason the user explicitly submits becomes a durable signal. That split matters: if the AI's own mistakes could reinforce themselves into permanent rules, one bad score could compound into a pattern of wrongly hidden postings with no way back. Restoring a posting clears its status and score without touching anything already learned.

### Jindr: one-at-a-time swipe review

Scrolling the Jobs tab's list works, but reviewing a backlog card-by-card is faster, especially on a phone — this is that, deliberately styled after the familiar swipe-to-decide gesture without renaming anything else in the app.

The **Jindr** tab builds its queue once, when the tab is opened, from the same eligible set the Jobs tab's own "matches" bucket already computes (excludes anything queued, ruled out, interested, or applied), always sorted best-match-first (`jobSortComparator('score')`) regardless of whatever sort the Jobs tab itself is set to. It's built once per visit rather than recomputed on every render, so a card doesn't reshuffle out from under a reviewer mid-pass. The card shows exactly what a candidate was previously scrolling and clicking through to find: the score badge, whichever `fit_detail_json` facts the candidate's own "What do you care about?" text produced (see "Job fit assessment (tier 2)" above) as small fact chips, the fit reason, and the gap list — no second LLM call, since these are the same tier-2 fields the Jobs tab's chips already read.

"Interested" and "Not for me" call the identical `submitJobFit(id, 'interested' | 'reject')` the Jobs tab's own buttons use, so a Jindr decision and a Jobs-tab decision are indistinguishable afterward. Dragging the card (pointer events, `translateX`/`rotate` following the pointer, a distance threshold to commit) is layered on top of the buttons as a shortcut, not a replacement — releasing short of the threshold just snaps the card back.

**Undo restores the exact pre-swipe record, not just the status, because `setJobFit`'s reject branch overwrites `fit_score`/`fit_reason` server-side.** By the time a reject is stored, the original score and reason are already gone — there's nothing left in the database to restore from. So the client snapshots the full job record before calling `submitJobFit`, and a new trusted `PATCH /jobs/:id/fit` action, `restore_snapshot`, writes every field (`fit_status`, `fit_score`, `fit_reason`, `fit_missing_json`, `fit_detail_json`) back verbatim from that snapshot rather than deriving a value. The Undo button only appears right after a swipe and clears once used, so it's available for exactly the one decision a reviewer might want to take back, not as a general history browser.

Deliberately not built: any preference-learning or recommendation model from swipe history. The queue is always plain best-match-first; a candidate reviewing 30 postings in a row doesn't change what order the next 30 arrive in.

### Resume pipeline

The governing rule is **the model writes content, code owns layout**. Letting an LLM improvise CSS on every generation is what produces inconsistent, amateur output, so the stages are separated (`src/resume.ts`):

1. **Compose** (LLM, structured output) — builds a `ResumeDoc` from the structured profile *plus* your Desired Roles description as the target. This is a selection-and-rewriting step, not a reformat: it chooses what belongs on the page, rewrites raw profile highlights into achievement bullets, and groups skills. The prompt separates hard constraints (never invent an employer, title, date, credential, or metric; no content an ATS can't parse) from strong defaults (reverse chronological, experience dominant, lead with the strongest evidence) from tunable preferences, so instructions can override the last group without touching the first.
2. **Ground** (deterministic) — every employer and school on the resume is matched back against the profile it came from. Prompting alone can't guarantee the model didn't invent one, so this check exists regardless.
3. **Render** (deterministic) — one of three hand-built single-column templates (`classic`, `modern`, `compact`), sized by a small set of clamped layout knobs. All three avoid the constructs ATS vendors document as parsing hazards: no tables, no columns, no text boxes, no images, contact details in the body rather than a page header.
4. **Check** (deterministic) — the generated PDF is re-parsed with `unpdf` the way an applicant tracking system would read it, verifying the name, every employer, and every school actually survive text extraction, and that the page count matches the target. This catches the failure mode where a resume looks right to a human but parses to garbage. Writing-level checks (first-person pronouns, duty-phrase openers, overlong bullets) run alongside.
5. **Review** (vision model, on demand) — see `POST /resumes/:id/review` above. The reviewer may only move the clamped layout knobs or request a content rewrite; it cannot emit CSS, and it is explicitly told not to ask for photos, icons, skill bars, or multi-column layouts.

[Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/) (`@cloudflare/puppeteer`, the `BROWSER` binding) does the HTML→PDF step and the screenshot, in one browser session so the image the reviewer sees is the same rendering the PDF came from. Note that `page.pdf()` is used rather than `page.createPDFStream()`: R2's `put()` rejects a stream whose length it can't determine up front. Launching the browser retries a couple of times with a short backoff on Browser Rendering's 429 (a burst of resume actions can trip its concurrent-session cap even though nothing is actually overloaded), so a transient cap becomes a brief wait instead of a failed generation.

**Fitting the page budget reliably.** A single design-review pass sometimes tightens spacing or type instead of actually cutting content, so a resume could come back over the page target after "one" revision — the candidate then had to click Revise again and type the same "fewer bullets, condense it" note themselves, sometimes more than once. `reviseUntilFits` (`src/index.ts`) automates that: it keeps re-running the design-review-and-revise pass — up to three attempts total — as long as the deterministic PDF page-count check (real text extraction, not the model's opinion) still shows overflow, feeding each retry an explicit, code-authored instruction to cut real content rather than shrink spacing further. Both the automatic pass `POST /jobs/:id/resume` runs on every generate, and the on-demand `POST /resumes/:id/review`, go through this loop, so a candidate doesn't have to manually repeat themselves. If it's still over after three attempts, the critique says so plainly rather than pretending the resume fits — usually a sign there's genuinely too much career history for the target page count.

These stages are deliberately separable because per-job tailoring reuses all of them — only the target input changes, from the general Desired Roles description to a specific posting.

Model provider configuration:

- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — Worker secrets (`wrangler secret put ANTHROPIC_API_KEY --env production`), not vars, not committed. `/profile/generate`, `/desired-roles/generate`, and `/resumes` (`POST`) all return `501` for a provider whose key isn't set.
- `ANTHROPIC_MODEL` / `OPENAI_MODEL` — plain (non-secret) vars in `wrangler.jsonc`, defaulting to `claude-sonnet-5` and `gpt-4o`. Bump these here if a model id is retired.
- **Ollama is intentionally not wired into the Worker.** It runs on a local machine with no public address, so Cloudflare's servers cannot call it directly. Using it from the phone dashboard would need a separate local-worker/queued-job component (per `docs/architecture/local-cloudflare-dual-mode.md`'s "optional local worker" and ADR-015's "queued" execution mode) — that's a distinct, larger piece of future work, not a config setting.

This is a first slice, not the full local-Python product surface — nor the full evidence-vault/job-matcher/verifier/reviewer resume-tailoring pipeline described in issue tracking for future work. Job-fit *assessment against a specific posting*, per-job tailored resume generation targeting one posting, and outcome-based learning (tracking which resume characteristics actually correlate with interviews) aren't built yet — see "Current boundary" below.

### The résumé doctrine agent (`src/philosophy.ts`)

"What belongs on this résumé" used to be an implicit judgment folded into the compose prompt. It's now an explicit, inspectable module, because it's the decision that most determines whether a résumé works.

The governing idea: **a résumé is not an autobiography, it's an evidence package answering one question — why should this employer believe this person can succeed in this particular job?** For every candidate line, ask what employer belief it creates; if there's no good answer, it doesn't belong. Keep evidence, not history.

That reframes the unit of decision. The unit is **not the job the candidate held** — it's the individual accomplishment inside it. Seven years of teaching is neither relevant nor irrelevant on its own; it contains curriculum design, adult training, stakeholder handling, assessment-data analysis, and maybe a Python automation project, and different targets activate different subsets. The historical fact never changes; its *evidentiary value* changes because the question changed.

**Four levels, not in-or-out.** Every past role is assigned `feature` / `include` / `compress` / `omit`, and code (not the model) owns what each buys in bullets. The same 15-year-old teaching job is correctly `feature` for a training role, `include` for customer education, `compress` for an engineering-manager role, and `omit` for an IC software role. That's the doctrine working, not inconsistency.

**Coverage before optimization.** `extractJobRequirements()` reads a posting into discrete, classified requirements (`must_have` / `responsibility` / `preferred` / `competency`) rather than treating it as a bag of words; `planEvidence()` then reports each as proven, partial, or unproven. Checking each stated requirement individually is the point — a globally "similar-looking" résumé can quietly drop the one line proving a required certification while keeping five attractive but less consequential ones. Requirements are cached on `job_postings.requirements_json` (they don't change between revisions); the plan is re-derived per build, since it depends on the current profile — an answer added on the Ask tab can legitimately turn an unproven requirement into a proven one.

**The anti-fabrication backstop is in code, not the prompt.** `normalizePlan()` demotes any `proven` claim whose cited evidence doesn't actually trace back to the profile. This is deliberately a content-word overlap test rather than exact substring matching: the model is *asked* to paraphrase ("delivered CRM onboarding" for "taught staff to use our customer database"), and an exact-match check would reject the honest case constantly. What distinguishes fabrication is that an invented accomplishment shares almost no specific vocabulary with the profile at all. The same function also defaults a role the model skipped to `compress` rather than letting it silently vanish, and derives every bullet budget from the level. Unproven requirements reach the writer as an explicit prohibition ("write nothing that claims, implies, or hints at these"), because left implicit, a writer that knows the target wants Kubernetes will reliably find some way to gesture at Kubernetes.

**Master archive** (`POST /resumes/master`, Resume tab). Capture everything first, then generate each tailored version by deleting from it — you can't select evidence you never wrote down, so an accomplishment missing from the archive can never appear on any tailored résumé. Its prompt is the inverse of the normal one: include every role, split combined accomplishments apart so later filtering can take them independently, make each bullet self-contained, no page budget, no selection. It deliberately skips the design-review and page-fit passes, which exist to make a document fit a budget this one doesn't have — running them would delete exactly the evidence the archive exists to preserve. One per profile, replaced in place.

Where the rules come from, cited at each rule in the source: [Randazzo, "A Framework for Résumé Decisions"](https://journals.sagepub.com/doi/abs/10.1177/2329490620963133) (*Business and Professional Communication Quarterly* 83(4), 2020 — 63 applicants/students, 20 advisers, 24 employers; the eight recurring reasons are relevance, recency, value, personality, fluff, unprofessionalism, discrimination, and applicant fit, and the paper's own conclusion is that these work as adaptive reasons rather than rigid rules, which is why this module ranks rather than hard-codes); UC Berkeley Career Engagement (the master-résumé-then-tailor architecture); Harvard Mignone Center for Career Success (concise, factual, skimmable, tailored); [NACE Job Outlook 2026](https://www.naceweb.org/job-market/trends-and-predictions/employer-use-of-skills-based-hiring-practices-grows) (70% of employers report skills-based hiring, up from 65%; GPA screening down to 42% from 73% in 2019); Yale Office of Career Strategy (out-of-industry work belongs when its skills translate); and [Neumark, Burn & Button](https://www.nber.org/papers/w21669) (40,000+ applications, robust hiring discrimination against older women) plus the ADEA's coverage of workers 40+, which is why `graduationDatePolicy()` stops spending space on a graduation year after ~10 years. That last one is explicitly *not* concealment — degree, institution, field, and all employment dates stay; it's a judgment that after a decade of professional history the year buys less than the space it costs, and it returns a recommendation the caller can override rather than a hard rule. `recencyWeight()` is likewise a decay curve rather than the conventional 10-to-15-year cliff, because a cliff is wrong at both edges: a mundane accomplishment from four years ago that proves nothing doesn't deserve space, and a rare, exactly-on-point one from seventeen years ago sometimes does.

### Error messages

Every place a generation/review/discovery call fails (`generation_failed`, `review_failed`, `discovery_failed`, `save_failed`) runs the thrown error through `friendlyMessage()` (`src/llm.ts`) before it reaches the dashboard, instead of surfacing the raw wire error. Without this, a provider failure showed up as the literal JSON body — `anthropic_error_400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low..."}}` — and a Browser Rendering capacity error showed up as `Unable to create new browser: code: 429: message: Rate limit exceeded`. Neither told the candidate what to actually do about it.

`friendlyMessage()` recognizes: an empty Anthropic/OpenAI credit balance, a provider rate limit, a rejected API key, a temporarily-overloaded provider, and the Browser Rendering session-cap 429, and turns each into one plain, actionable sentence. Anything it doesn't recognize passes through unchanged — a genuinely new failure mode is never silently hidden behind a generic message. The frontend's `errorMessage()` helper then shows that `detail` on its own rather than prefixing it with the internal error code, since a friendly detail already reads as a full sentence.

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

## Model-call tracing and the developer console (`/dev`)

Every prompt this app sends is recorded, and `/dev` is where you read them. It is a developer tool, not a product surface: it exists so the prompts can be worked on deliberately instead of inferred from whatever the dashboard happens to render.

The motivation is concrete. The description-capture problem survived five rounds of fixes because the scoring model was answering honestly about text nobody could see — each fix was real and necessary, and none of them was checkable from the UI, because a dropped section looks exactly like a posting that genuinely omits one. A trace makes that difference visible in one click.

**How it's wired.** `src/llm.ts` is the single choke point every model call passes through, so instrumentation lives there rather than at the twelve call sites: there is one place to get right, and a new call site cannot forget to opt in. Each call now takes a task id as its third argument, and the transport stamps that id onto the trace it writes, giving a stable key to group by.

- `src/tasks.ts` names all twelve calls with a description, tier, pipeline stage, and the function that builds the prompt. The console renders the registry joined onto the trace data, so a call that has **never run** still appears — "this prompt has never been exercised" is a finding, not an empty row to hide.
- `migrations/0015_llm_traces.sql` stores prompt and response **in full**. A trace whose input you cannot read is useless for evaluating a prompt, which is the entire point of keeping it. Retention is a rolling cap (`TRACE_RETENTION`, 2000 rows) pruned in code, sampled at ~2% of writes rather than run on every insert — calls arrive eight at a time and a full ordering scan per call would cost more than the tool is worth.
- Cost comes from a published-price table in `src/llm.ts`, in USD per million tokens, with date snapshots stripped (`claude-haiku-4-5-20251001` prices as `claude-haiku-4-5`). Sonnet 5's introductory rate is encoded with its expiry so spend is reported correctly on both sides of that date instead of being overstated by 50% until it lapses.
- **A model with no price on file records `NULL`, never `0`.** Pricing an unknown model at zero would make the dashboard worse than having none — the console instead names the unpriced models and says plainly that totals are an undercount.
- Tracing failures are swallowed inside `llm.ts`: observability must not be able to break the thing it observes. Set `LLM_TRACE=off` to stop recording entirely.

**Access.** `/dev` is gated on the same device session as the dashboard. The traces contain every prompt in full, which means the candidate profile and the postings being assessed — at least as sensitive as the dashboard itself, so it gets the same protection rather than being left open on the grounds that it is "just a debug page".

**On reading the numbers.** Batched calls are marked as such in the console. One screen call covers 60 postings and one assess call covers 8, so per-call cost and per-posting cost differ by an order of magnitude and the table says which it is showing.

`assert_dev_console.mjs` covers the price maths (including the introductory-rate boundary and the unknown-model case), the console itself, and — most importantly — parses the real source to assert that every call site's task id exists in the registry and every registered task is wired to a call site. A task id is a positional string, so a typo files traces under a name the console never shows: silent, and invisible from the UI. That check was verified to fail when a call site's id is altered.

## Langfuse tracing (optional, richer than `/dev`)

The `/dev` console above is a homegrown tool: enough to read a prompt and its cost, not a full observability product. [Langfuse](https://langfuse.com) is that product — a proper trace timeline per call, cost and latency dashboards that slice by model/task/day, and (the reason it's worth wiring in) **no-code LLM-as-judge evaluators** that grade live traces automatically, none of which `/dev` tries to build. It has a generous free tier, so this is "on by default once you set two secrets," not a paid upgrade.

**How it's wired.** `src/langfuse.ts` sends every model call to Langfuse, automatically, for every task and either provider (Anthropic or OpenAI) — it hooks into `llm.ts`'s `record()`, the same single choke point that already writes to `llm_traces`, so there was no call site to remember to opt in. One LLM call becomes one Langfuse **trace** with one **generation** inside it: name, prompt, response, model, tokens, cost, latency, and ok/error, shaped straight from the `LlmTrace` object the local sink already builds. Batched calls (`screenJobsBatch`, `assessJobFitBatch`) already cover many postings per call, so this granularity is naturally "one thing that happened" without threading a request-scoped session id through a dozen call sites.

Deliberately raw `fetch` against Langfuse's current OTLP/HTTP JSON endpoint (`POST /api/public/otel/v1/traces`), not a process-global OpenTelemetry SDK. A general-purpose SDK's ambient span context can leak across concurrent requests sharing a Cloudflare Workers isolate. Building one standards-compliant OTLP envelope per completed call keeps the exporter stateless while using Langfuse's v4 data model. The exporter sends `x-langfuse-ingestion-version: 4`, so observations are ingested into the real-time path rather than the delayed compatibility path.

**Setup.**

1. Create a free account at [cloud.langfuse.com](https://cloud.langfuse.com) (EU region) or [us.cloud.langfuse.com](https://us.cloud.langfuse.com) (US region) and a project inside it.
2. Project Settings → API Keys → create a new key pair.
3. Set the two secrets (and the base URL if you picked a region other than EU or you're self-hosting Langfuse):
   ```
   npx wrangler secret put LANGFUSE_PUBLIC_KEY --env production
   npx wrangler secret put LANGFUSE_SECRET_KEY --env production
   npx wrangler secret put LANGFUSE_BASE_URL --env production   # e.g. https://jp.cloud.langfuse.com for Japan
   ```
4. For local development, the `npm run dev` script loads both the repository-root `.env` and
   `cloudflare/.dev.vars` via Wrangler's `--env-file` option; `.dev.vars` takes precedence when a
   variable exists in both. `LANGFUSE_HOST` remains supported as a backward-compatible alias.

That's the entire setup — no other config, no schema to define on the Langfuse side. The next model call this app makes shows up in your project's Traces tab.

**Viewing it.** Open your Langfuse project's Traces tab: every call, filterable by name (the task id, e.g. `resume.build`, `fit.assess`), model, or whether it errored, each with the full prompt/response and a cost/latency breakdown. This runs *alongside* `/dev`, not instead of it — `/dev` still works with zero setup and is faster for a quick look; Langfuse is where you go to actually dig in, compare, or set up automated grading.

**Dev console integration.** The `/dev` header shows whether Langfuse is configured, with a link to open it. Every trace detail that made it to Langfuse also gets an "Open in Langfuse" link, straight to that specific trace — `langfuseTraceUrl()` in `langfuse.ts` resolves the project id behind your key pair once per isolate (`GET /api/public/projects`, cached in module scope, the same "practically never changes" caching pattern `ensureSchema` and `attachTraceSink` already use) and builds `/project/{id}/traces/{traceId}`. A failed lookup just falls back to linking the dashboard root rather than a broken link.

**LLM-as-judge.** This app already has its own judge (`evals.judge`, see below) for scoring eval replays against a saved case. What Langfuse adds is a *second*, zero-code judge: its **Evaluators** feature (Langfuse project → Evaluators) runs an LLM-graded rubric automatically against live traces matching a filter you set — e.g. grade every `resume.build` trace for tone, or every `fit.assess` trace for whether the reason actually cites the posting. Nothing in this codebase needs to change to use it: the traces already carry the `input`/`output` text an evaluator template reads, since that's exactly what `sendToLangfuse()` populates on every call. Configure it once in the Langfuse UI and scores start appearing on the matching traces going forward.

**Eval replays are deliberately excluded, same as the local trace table.** `evals.ts`'s `replayTask()` already strips the D1 sink for the same reason the header comment there gives — "an eval run is not production spend... letting it write into `llm_traces` would quietly inflate the Cost tab's totals with experimentation nobody asked the app to do" — and it strips the two Langfuse keys off the isolated env for the identical reason: a candidate comparing models in the eval harness shouldn't see their Langfuse project fill up with test replays. The one exception is the same one D1 already carves out: `judgeRun()` runs through the real env and is traced (and now sent to Langfuse) normally, because judging genuinely costs money and should be as visible as any other call.

**Failure handling.** Every function in `langfuse.ts` follows the same rule `record()` in `llm.ts` already does: observability must never be able to break the call it's observing. `sendToLangfuse()` and the project-id lookup both swallow their own errors and return `null` rather than throwing — a Langfuse outage, a wrong key, or no configuration at all just means nothing gets sent that time, silently, with the LLM call itself unaffected.

## Prompt Management

Substantive LLM instructions are managed in Langfuse Prompt Management rather than hardcoded in the repository. Every runtime call fetches the prompt's `production` label, compiles its `{{alphabetic_or_underscore_variable}}` values, and passes the resulting text into the existing provider call. The fetched prompt name, ID, and version are attached to the Langfuse generation so an output can be traced back to the exact prompt version that produced it. Existing task names such as `fit.assess` and `resume.build` remain unchanged.

To change a prompt, open it in Langfuse, create a new version, and test that version without moving the `production` label. Promote it by assigning `production` to the approved version; runtime code never pins version numbers. New prompts should use the slash hierarchy already established (`roles/...`, `jobs/...`, `resume/...`, `applications/...`) and must define every runtime value with `{{variable_name}}`. Missing variables fail with `langfuse_prompt_missing_variables` instead of sending malformed instructions to a model.

Model/provider routing remains in [`src/llm.ts`](src/llm.ts), and JSON schemas plus Anthropic tool definitions remain beside their call sites. Prompt Management does not control either one.

For local development, set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` in the repository `.env`; Japan-region projects use `https://jp.cloud.langfuse.com`. Run `npm run migrate:local` once so migration `0023_langfuse_prompt_cache.sql` is applied, then start the app normally. Production should apply the same migration before deployment.

Prompt retrieval uses a five-minute in-isolate cache. Every successful fetch is also written to D1 as the last-known-good production prompt. If Langfuse is temporarily unreachable, ApplyGo uses that persistent cached version; a fresh installation that has never fetched the prompt fails clearly with `langfuse_prompt_unavailable:<name>` rather than silently substituting different instructions. The legacy Python service uses the same production label and stores its last-known-good cache under `data/private/`.

### Prompt contracts and bundled defaults

A prompt whose *contract* changes — a new structured-output schema, a new set of input variables — needs one extra guarantee that the mechanism above does not provide. `compilePrompt` fails when a template references a variable the code stopped sending, but **not** the other way around: a template that never mentions a newly added variable compiles perfectly happily. So shipping a schema change would otherwise run silently against the old production prompt, telling the model to build the previous thing while the schema forces the new shape. Nothing errors, and the result is a valid-looking, semantically degraded output.

[`src/prompts.ts`](src/prompts.ts) closes that gap. Each entry there pairs the canonical prompt text with a `requires` list naming the variables a template must actually reference to count as current. `getManagedPrompt` falls back to the bundled text when Langfuse holds no prompt at all *or* holds one that references none of them — and it applies that check to the D1 last-known-good copy too, since a stale cached prompt is exactly as incompatible as a stale live one.

This does not move prompt ownership back into the repository. Langfuse still wins whenever it holds a compatible version, and the bundled text goes dormant the moment one is promoted. What it buys is that a schema deploy and a prompt promotion no longer have to happen in the same instant, and that the repo carries a readable record of what each prompt is supposed to say. A prompt served from the bundled default reports its name as `<name> (bundled default)` and version `0`, so it is obvious in a Langfuse trace.

Every prompt registered in `PROMPT_DEFAULTS` (`profile/create`, `profile/improve-audit`, `profile/improve-apply`, `roles/analyze`, `roles/research`) currently has a matching `production` version in Langfuse, so the bundled text is dormant for all of them. If a schema change ever outruns the Langfuse promotion again, copy the new text from `src/prompts.ts` into a new Langfuse version, keep every `{{variable}}` it references, and promote it to `production`.

### Creating `applications/generate_answer`

`POST /applications/generate-answer` (extension → Generate button) fetches this prompt by name and fails with `langfuse_prompt_unavailable:applications/generate_answer` until it exists with a `production` label. It doesn't ship in the repo — create it once, by hand, in Langfuse:

1. Langfuse → Prompts → New prompt → name it exactly `applications/generate_answer`, type **Text**.
2. Paste the template below as the prompt content, then **Save as new version**.
3. Promote that version's label to `production`.

```
You are drafting one answer for a job application, on behalf of the candidate described below. The
candidate will read and edit this before it is used, so an honest, well-grounded draft is more
useful than a polished but invented one.

Employer's question: {{question}}
Field type: {{field_type}}
Character limit (if any): {{max_length}}

Applying for: {{job}}
Company: {{company}}
Job description:
{{job_description}}

Candidate's structured profile:
{{candidate_profile}}

Relevant evidence from this candidate's own notes about this job/company:
{{review_context}}

Answers the candidate has already given on other questions (for tone and consistency, and to reuse
real context rather than reinvent it):
{{saved_answers}}

Write a draft answer to the employer's question above. Ground every claim in the profile, evidence,
and job description given above -- never invent experience, credentials, achievements, dates,
metrics, or employers, and never state a fact you would need to guess. If the available material
only weakly supports a good answer, still write the best honest draft you can, but be conservative
about specifics rather than filling gaps with plausible-sounding invention. If a character limit was
given, stay within it.

Write like the candidate would actually write, not like an AI answering a prompt. That means:
concrete and specific to this exact question, company, and role -- not something that could be
pasted into any application unchanged. Plain, direct sentences over polished marketing language.
No throat-clearing openers ("I am excited to..."), no stacked buzzwords, no generic enthusiasm
that isn't backed by something real in the material above. Say the actual thing, in the fewest
words that say it well. If the honest answer is short, let it be short.

Set `grounded` to true only if the draft is well-supported by the material above; set it to false
if this is a best-effort draft with meaningfully limited support -- the candidate reviews and edits
every draft either way, so say so honestly rather than hiding it.
```

Every `{{variable}}` above must stay present verbatim — `compilePrompt` throws `langfuse_prompt_missing_variables` if the code ever calls this prompt without supplying one, and throws `langfuse_prompt_unresolved_variable` if the template references one the code doesn't send. The code sends exactly these nine: `question`, `field_type`, `max_length`, `job`, `company`, `job_description`, `candidate_profile`, `review_context`, `saved_answers` (`generateApplicationAnswer` in `src/index.ts`). Model/provider routing and the response schema (`answer`, `grounded`) stay in code, not in this prompt, per the split described above.

### Creating `applications/resolve_option`

`POST /applications/resolve-option` (extension → last resort before asking the candidate about a fixed-choice field) fetches this prompt the same way and fails the same way until it exists. It's the model-assisted fallback for when content.js's own fast, rule-based synonym matching (`findOptionMatch`) can't confidently match a known answer to one of the employer's real options on its own — a decorated option ("United States+1" rather than "United States") or an unanticipated phrasing, not a case where ApplyGo doesn't know the answer.

1. Langfuse → Prompts → New prompt → name it exactly `applications/resolve_option`, type **Text**.
2. Paste the template below as the prompt content, then **Save as new version**.
3. Promote that version's label to `production`.

```
You are matching a candidate's already-known answer to the correct choice on an employer's job
application form. This is not a place to invent or guess a fact -- the candidate's answer is
already given below, and every option you can choose from is copied verbatim from the employer's
own form. Your only job is to say which one of those options is what the candidate's answer means,
if that's actually obvious.

Employer's question: {{question}}
Candidate's answer: {{candidate_answer}}

The employer's real options:
{{options}}

Pick the one option that the candidate's answer clearly and unambiguously means. Copy it back
exactly as written above -- do not paraphrase, abbreviate, or alter it in any way. If more than one
option could plausibly match, or if nothing on the list is a clear match, set option to null rather
than guessing: the candidate will be asked to choose for themselves in that case, which is a much
better outcome than a wrong answer silently submitted on their behalf.

Set confident to true only when the match is obvious, not merely plausible.
```

### Creating `companies/resolve_website`

Company discovery's website resolution has two tiers: a free, instant, deterministic slug-guess (`resolveCompanyDomain` in `src/companies.ts`) tried first on every company, and this prompt as the fallback used only when that guess fails. It's the one place in company discovery/verification that calls a model at all, and it does so through Claude's own server-side web search (`callWithWebSearch` in `src/llm.ts`), never from memory alone -- a bare company name is not enough to know which real organization it refers to. Its result is never trusted outright either: `scanOneCompany` (`src/index.ts`) always re-verifies the URL it returns (fetches it, confirms it resolves, looks for real company/careers evidence) before marking anything Verified from it, and anything below `WEBSITE_SEARCH_CONFIDENCE_FLOOR` (60) is left Unverified with reason `ambiguous` rather than accepted. Fails with `langfuse_prompt_unavailable:companies/resolve_website` until it exists with a `production` label -- until then, a company whose slug-guess fails simply stays Unverified/`no_website`, same as if this fallback didn't exist.

1. Langfuse → Prompts → New prompt → name it exactly `companies/resolve_website`, type **Text**.
2. Paste the template below as the prompt content, then **Save as new version**.
3. Promote that version's label to `production`.

```
You are finding a specific company's real, official website using web search -- this matters because
a name alone is not enough to be sure: many companies share similar or identical names, and guessing
from memory risks confidently pointing at the wrong organization entirely. Search the web and confirm
your answer with real, current evidence before answering; do not rely on what you already know about
a company by that name without checking.

Company name: {{company_name}}
Location (if known): {{location}}
What ApplyGo actually saw this company hiring for (use this to tell the right company apart from an
unrelated one that happens to share its name): {{signal}}

Search for this company and find its real, official homepage and, if you can find one, its careers or
jobs page. Use the location and hiring signal above to confirm you have the right organization, not
just a plausibly-named one -- a small company can easily share a name with an unrelated business in a
different industry or country, and the location and hiring signal are what tell them apart.

When you submit your answer: set official_website to the company's real homepage URL if you're
reasonably confident you found the right company, or leave it empty if you couldn't confirm one. Set
careers_url to their careers/jobs page if you found one during your search, else leave it empty. Set
confidence to a 0-100 score for how sure you are this is the right company, not merely a plausible one
with a similar name -- a strong, well-evidenced match should score high; a same-name company you
cannot rule out should score low. Set reason to one sentence citing what specifically confirmed the
match, or explaining why you're unsure.
```

The code sends exactly three variables: `company_name`, `location`, `signal` (`resolveWebsiteViaSearch` in `src/websearch.ts`). The output schema (`official_website`, `careers_url`, `confidence`, `reason`) is an Anthropic tool definition in code (`WEBSITE_RESOLUTION_SCHEMA`), not part of this template, per the same model/schema-stays-in-code split as every other prompt here. Requires `ANTHROPIC_API_KEY` specifically -- this capability has no OpenAI equivalent and is silently unavailable (not an error) when that key isn't configured.

The code sends exactly three variables: `question`, `candidate_answer`, `options` (`resolveApplicationOption` in `src/index.ts`). The server never trusts the model's echoed option text over the real list either — a returned value that doesn't exactly match one of the options given is treated the same as no confident match, so this can never introduce a choice that wasn't actually on the employer's form.

## Company discovery and job scanning

The Companies tab is a three-stage pipeline — **Discovery → Verify → Pre-screen** — that finds companies from real, current hiring activity, confirms each one is a real, monitorable employer, and hands their job postings to the same Jobs pipeline everything else feeds. Each stage counts a different unit, and the UI never blends them: Discovery counts job **postings** (with unique companies as a secondary figure), Verify counts **companies**, Pre-screen counts **jobs**. A search summary reads "269 companies discovered · 214 verified · 57 jobs imported," never "found 269, verified 214, imported 57" — every number always carries its own unit.

**Search terms** are the actual, literal Adzuna queries — not a friendly gloss over something else. `GET/PUT /companies/search-terms` and `POST /companies/search-terms/regenerate` (Companies tab → Search → the chip list under "Search terms") manage a list of `{term, source: "generated" | "manual"}` stored in `preferences_json.company_search_terms`. The generated set is a capped (15), title-cased extraction of the candidate's already-analyzed target roles (`roleTitleTerms(readRoleAnalysis(...))` — the same extraction Adzuna's query-building and the board role-filter already use elsewhere, deliberately not a second LLM call just to name the same roles again). Editing is add/remove/edit chips, never JSON; removing a term is deletion from the array, with no separate tombstone. "Reset to suggested" (`regenerateCompanySearchTerms`) replaces only `source: "generated"` entries with a fresh extraction — every `source: "manual"` term the candidate typed survives untouched, and a regenerated suggestion that case-insensitively duplicates a manual term is dropped rather than shown twice. The pure shaping logic (`companySearchTermsFromTitles`, `mergeCompanySearchTerms`, `titleCaseTerm`) lives in `src/companies.ts` so it's unit-tested independent of the DB-backed read/write around it.

**Discovery** (`POST /companies/discover`, Companies tab → "Find companies") searches Adzuna for each configured search term crossed with each of the candidate's target locations (or once, unfiltered, if no location is set), plus an optional free-text "Search focus" appended to every term. Every `(term, location)` pair is a persisted row in `company_discovery_streams` (migration `0028_company_discovery_streams.sql`) tracking its own `next_page`, `exhausted`, `total_available`, `postings_seen`, and `last_searched_at` — pagination is resumable per stream, not per click. A click processes a bounded batch (8) of the least-recently-searched, non-exhausted streams matching the *current* search terms/locations, advancing each one's own cursor; a stream is marked exhausted only once Adzuna's own `count` confirms no postings remain, never assumed from an empty page alone. "Find companies" therefore means **continue**, not restart — a term removed from the configured list simply stops being selected (no cleanup needed, since the natural `(term, location)` pair is its own identity), and a changed term/location becomes a new stream rather than resetting anything else. A `429` from Adzuna is distinguished from any other failure and leaves that stream's cursor untouched (safe to retry next click) instead of advancing or marking it exhausted; the status line says so plainly ("Search paused at the job board's rate limit — click Find companies again to continue.") alongside how many streams are left. Posting-level dedup uses Adzuna's own posting `id` first (so overlapping pages across repeated searches never double-count), falling back to company-name grouping only where no `id` is present.

**Verify** (folded into the same "Find companies" click, `scanCompanies`/`scanOneCompany` in `src/index.ts`) resolves each newly discovered company's website and job board, deterministically. Every company first gets a free, instant slug-guess (`resolveCompanyDomain` in `src/companies.ts`, tries `{slug}.com`/`.io`/`.ai` and confirms with a real fetch) — no LLM involved. If that fails, and only on a company's first-ever scan, `scanOneCompany` calls `resolveWebsiteViaSearch` (`src/websearch.ts`), which uses Claude's own server-side web search (`callWithWebSearch` in `src/llm.ts`, the `companies/resolve_website` Langfuse prompt) to find a candidate URL grounded in real search results — never from model memory alone, and never trusted outright: any proposed URL is still run through the same deterministic `verifyWebsite()` check as everything else before being accepted, and a match scoring below `WEBSITE_SEARCH_CONFIDENCE_FLOOR` (60) is left `unverified`/`ambiguous` rather than guessed. `classifyVerification` (`src/companies.ts`) assigns one of five reason codes when a company doesn't verify: `no_website`, `no_job_board`, `unsupported_ats`, `board_unreachable`, `ambiguous`. Every eligible company (not just newly discovered ones) is re-checked on every "Find companies" click, which is what actually retries a previously `unverified` company later — except `unsupported_ats`, which is skipped for 14 days after its last check (a genuine capability limit of this app, not something a re-check fixes, so retrying it every click would just burn budget confirming the same outcome). A location mismatch is never classified as a verification failure — it's a separate `off_target` filter applied before verification is even attempted.

**Pre-screen** is not a third stage of company-level work — it's the count of jobs already imported from verified companies' boards, sitting in Jobs' own Pre-screen queue (`SELECT COUNT(*) FROM job_postings WHERE company_id IS NOT NULL AND fit_status = 'unassessed'`), the exact same query and the exact same rows Jobs' own "Search → Pre-screen" shows. There is no separate Companies-side copy of job data. The Companies Sankey (`#cpf-svg`, `createPipelineFlow` — the same generic pipeline-flow engine `#jobs-pipeline` uses, sized to match its node/font/stroke density) renders Discovery → Verify as one real ribbon-conserved diagram (both stages count companies, so a conserved flow is honest); Pre-screen sits visually joined to its right in the same row, connected by a small arrow, but is deliberately not folded into that ribbon graph, since its unit (jobs) isn't the same thing being conserved on the left.

**Known limitations**, not yet addressed: Adzuna's `company.display_name` is sometimes the placing staffing agency rather than the real employer, with no filtering for that yet; Adzuna is queried per-country (`ADZUNA_COUNTRY`, default `us`), so a candidate targeting other countries gets no results without an obvious explanation why; Adzuna's free tier is rate-limited (handled — see the 429 behavior above — but still means discovery can take multiple clicks to fully catch up on a fresh install with many search terms); and discovery only ever sees whatever Adzuna's index currently returns, so a real opening never indexed there, or one that's fallen out of the index, is invisible to this pipeline regardless of how well the search terms are tuned.

## Adzuna job-market discovery

**Company discovery is grounded entirely in real, current hiring activity, not an LLM's memory or judgment.** `POST /companies/discover` (Companies tab → "Find companies") searches the [Adzuna Job Search API](https://developer.adzuna.com/) for postings matching the candidate's target roles and locations, then builds the company list from those real results — see "Company discovery and job scanning" above for the full pipeline (Discovery → Verify → board scanning). There is no LLM-recall fallback or alternate discovery source; Adzuna is the only one, and there is no company-level AI judgment anywhere in the pipeline at all (see that section's opening paragraphs for why).

Adzuna has a free developer tier and no OAuth flow — same shape as the Langfuse setup above, a static key pair rather than a per-user connection.

**Setup.**

1. Register a free account and app at [developer.adzuna.com](https://developer.adzuna.com/) to get an **App ID** and **App Key**.
2. Set the secrets:
   ```
   npx wrangler secret put ADZUNA_APP_ID --env production
   npx wrangler secret put ADZUNA_APP_KEY --env production
   npx wrangler secret put ADZUNA_COUNTRY --env production   # optional, ISO country code, defaults to "us"
   ```
3. For local development, add the same three to `cloudflare/.dev.vars`.

Until these are set, `POST /companies/discover` fails with `501 {"error":"adzuna_not_configured"}` — the Companies tab's "Find companies" button won't do anything. Manual add (single company or pasted list) works independently of Adzuna and always has, so a fresh install without an Adzuna key yet can still build a company list by hand while it's being set up.

**Known limitations** — see "Company discovery and job scanning" above for the full list (staffing-agency noise in `company.display_name`, per-country querying, rate limits, point-in-time coverage).

## Gmail reply-checking (optional, read-only)

The Applied tab can check the candidate's own Gmail inbox for replies from companies they've applied to — "did anyone from Acme email me back?" — without ever sending, modifying, or deleting anything. This is the app's first three-legged OAuth integration; everything else external (Anthropic, OpenAI, Langfuse) is a static API key.

Gmail is entirely optional — the rest of ApplyGo works without it. Connecting it only enables the "Check for replies" button on the Applied tab.

Because ApplyGo is self-hosted, there's no shared Google OAuth app every installation can use — Google ties an OAuth client to one app identity, and a single shared one would mean every ApplyGo user's Gmail grant lived behind the same credentials. Instead, **each installation registers its own Google OAuth app and enters its own Client ID/Secret**, entirely through the UI:

**Settings → Email → follow the built-in "How do I get these?" walkthrough → paste the Client ID and Client Secret → Connect Gmail.**

No `.env`/`.dev.vars` editing, no `wrangler secret put`, no redeploying — the walkthrough is written for someone who has never opened Google Cloud Console before, includes the exact **Authorized redirect URI** this installation needs (with a Copy button — it differs between `http://localhost:8787` and a deployed domain, so the app computes it from the live request rather than hardcoding one), and Settings → Email shows one of four states (**Not configured** / **Ready to connect** / **Connected** / **Connection expired**) so it's always clear what to do next.

**How it's wired.** `src/gmail.ts` holds the OAuth token exchange/refresh and the Gmail search call; the actual routes (`/gmail/credentials`, `/gmail/connect`, `/gmail/callback`, `/gmail/status`, `/gmail/disconnect`, `/gmail/check-replies`) live in `index.ts` like every other handler. Two things are stored on `candidate_profiles`, in separate columns from each other and from `preferences_json`:
- `google_oauth_json` — the OAuth app registration (Client ID/Secret) entered in Settings → Email. Effectively permanent once set; disconnecting Gmail never clears it.
- `gmail_json` — the actual connection (access/refresh token, expiry, connected address, and a `needs_reconnect` flag). Cleared on Disconnect; the app registration above survives that.

Both are kept out of `preferences_json` on purpose: that column is echoed close to verbatim in `GET /profile`'s response, so anything sensitive has to live somewhere `getProfile()`'s query never selects. `GET /gmail/status` is the only reader of either column, and it only ever returns a secret-free shape — connection state, the (non-secret) Client ID, and the redirect URI. The Client Secret is never sent back to the browser once saved, never logged, and never appears in a Langfuse trace or error message; `POST /gmail/credentials` accepts it once, writes it, and returns nothing but a confirmation.

`GET /gmail/status` is also a passive read — it never attempts a live token refresh — because the frontend's global `api()` helper treats *any* HTTP 401 from *any* endpoint as "the session is dead, log out," and a Gmail-specific problem must never trigger that. A stale/expired connection is instead discovered the next time `POST /gmail/check-replies` actually tries to use it, which persists a `needs_reconnect` flag rather than just returning an error, so Settings → Email shows "Connection expired" on its next load without needing to run a check first.

"Check for replies" (Applied tab) is one click that, for every applied job, searches Gmail for `"<normalized company name>" after:<applied date>`, using the same `companyNameKey()` punctuation/legal-suffix stripping the Companies tab already uses for dedup. Results are **not persisted** — they exist only in the browser for that page load, re-running the check just re-queries Gmail. Very short/generic company names (≤3 characters after normalization) are skipped rather than searched, since a short name matches too much unrelated mail to be a useful signal.

**About the 7-day reconnect.** `gmail.readonly` — the only scope this app ever requests — is one of Google's *sensitive* scopes. While your OAuth app's publishing status is **Testing** (the guided setup's default, and the recommended path for a personal installation), Google expires refresh tokens **7 days** after they're issued; when that happens, Settings → Email shows "Connection expired" and a Reconnect Gmail button — nothing is lost, it's a one click fix. Moving your OAuth app out of Testing status requires completing Google's sensitive-scope verification (a privacy policy, domain ownership verification, and a Google review) — real overhead intended for apps with outside users, not something a personal single-user tool needs. Staying in Testing and reconnecting occasionally is the recommended default for this first version.

**Advanced: environment-variable configuration.** For developers or automated deployments, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` can still be set the conventional way (`.dev.vars` locally, `wrangler secret put ... --env production`) instead of through Settings → Email. Credentials entered in Settings → Email always take precedence over the environment variables if both are present — `resolveGoogleOAuthClient()` in `index.ts` is the one place that decides which wins.

**Failure handling.** No `/gmail/*` route ever returns a bare HTTP 401 — the frontend's `api()` helper treats any 401 from *any* endpoint as "the whole app session is dead, log out," and a Gmail-specific problem (not connected, needs reconnecting) must never trigger that. `GET /gmail/status` is a passive read with no live refresh attempt; `POST /gmail/check-replies` surfaces a stale/expired connection as `{error:"gmail_reconnect_required"}` on a 400, which the client shows as a prompt to reconnect rather than a generic error.

## Eval harness (`/dev`, Evals tab)

Traces make a prompt visible; the eval harness is what makes changing one accountable. A **case** is a saved prompt worth testing repeatedly — usually promoted from a real trace, sometimes hand-authored. A **run** is one execution of a case against a chosen provider/model, scored by an LLM judge. Both live in `src/evals.ts`, `migrations/0016_evals.sql`, and the Evals tab in `src/devconsole.ts`.

- **Replay reuses the exact recorded prompt, not a reconstruction of it.** Because PR1's tracing stores every prompt as a plain rendered string, replaying it is just resending that string — no need to re-derive what was actually sent from the objects that built it. `replaySpecFor()` in `src/index.ts` maps each task to the JSON Schema/tool name/token budget its structured call needs, built from schemas already exported by `fit.ts`/`companies.ts`/`resume.ts`/`index.ts` — kept in `index.ts` rather than `evals.ts` specifically to avoid a circular import back into the four schemas defined there. `resume.design_review` (sends a screenshot, never stored) and `evals.judge` itself are not replayable; `tasks.ts` marks every task's `replayable` flag explicitly rather than leaving it implicit.
- **A replay never touches the production trace table.** `replayTask()` installs a throwaway `LLM_TRACE_SINK` for the duration of one call and captures what it recorded locally, so experimenting with a model swap never writes into `llm_traces` and never inflates the Cost tab's totals with spend the app didn't actually decide to make. This was the one piece of the harness worth a dedicated non-UI test (`assert_evals_engine.mjs`) — verified to fail when the isolated env is swapped for the real one.
- **The judge is the deliberate exception.** `judgeRun()` runs through the real `env`, traced normally under a new `evals.judge` task (`stage: "Developer tools"`), because judging a run is genuine spend and hiding it from the Cost tab would defeat the point of tracing in the first place. It scores 0-100 against the task's own registered description (`what` in `tasks.ts`), plus the case's free-text `notes` field appended verbatim — a lightweight per-case rubric without building rubric-authoring UI.
- **Reproducibility per run, not just per case.** A run can be fired with an edited prompt without mutating the saved case (`eval_runs.prompt` is the prompt actually sent for that run, which may differ from the case's current prompt if edited afterward).
- **Comparison is a plain runs table**, not a diff view — every run of a case lists provider, model, judge score, cost, and latency side by side, which is enough to answer "did switching models help" without building a bespoke comparison UI.

`assert_evals_engine.mjs` (13 assertions, no browser) exercises `replayTask`/`judgeRun` directly with a stubbed provider fetch — the isolation check, model-override honoring, unpriced-model handling, the failure path, and judge score clamping (0-140 → 100, -20 → 0). `assert_evals.mjs` (18 assertions, Playwright) covers the full flow through the console: a replayable trace offers "Save as eval case" and a non-replayable one (`resume.design_review`) does not; the new-case task select only lists replayable calls; editing and saving a case's prompt persists; running the same case against two different models produces two comparable rows with different scores; a failed run is listed unscored rather than dropped.

## UI audit fixes

A screenshot-and-source pass over all 11 tabs at phone and laptop widths, in both themes, produced six findings; all six are fixed. They're recorded here because most of them were the kind of thing that only shows up when a screen built in one round is compared against the ones built around it.

- **The tab row gave no sign it scrolled.** Eleven tabs never fit on a phone, the scrollbar is hidden, and switching tabs could leave the new active one clipped mid-word. The active tab now scrolls itself to centre on click, and each edge of the row fades **only when there is actually something that way** — a symmetric always-on fade washes out the first tab when you're already at the start, which makes the active pill look broken rather than scrollable. Driven by a passive scroll listener toggling two classes (`.can-scroll-left` / `.can-scroll-right`).
- **Every match badge was green.** `verdictForScore()` has always split strong (70+) from possible (40–69), and the scoring prompt calls 40–69 "a genuine stretch or a posting too vague to be sure" — but `.badge.possible` shared `--success` with `.badge.strong`, so a 55% looked exactly as settled as a 92%. It now shares the existing amber `--warning` tier with "not filtered yet", which is the honest grouping: both mean *read this before trusting it*. Jindr's score badge had the same bug in a worse form — the class was hardcoded `badge strong` in the markup — and now derives its tier from the posting like the Jobs rows do.
- **Applied's undo was labelled like a status.** See the Applied bullet above.
- **Two-column tabs went lopsided in both directions.** Profile's left column stacked four separate concerns and ran about twice the right; moving Application answers out fixed it at the source. Desired Roles had the opposite problem — a short left column against a long form, leaving a tall dead gutter — so that column is now `split-sticky` and travels with the form, which is also just more useful, since those notes are the source material the description is generated from.
- **Jindr looked like a list tab with one row in it.** It's the one screen built around a single decision, so it now reads like one: the section is capped and centred instead of stranding a small card in the corner of a wide window, with a larger title and more room around the two decision buttons.
- **Reset and Delete looked as casual as Rename.** Both are gated behind `window.confirm()`, so this was never one-click data loss — but nothing signalled "this one's bigger" *before* the dialog, and resetting a pipeline stage can mean redoing hours of scanning. They now use a new `.destructive` class (red outline at rest, reusing the vocabulary Jindr's "Not for me" already established). Deliberately **not** applied to the app's nine other `.danger` buttons, which drop one row you could add back in seconds — escalating those too would just re-flatten the distinction in the other direction.

Two things that looked like findings were checked and ruled out: the all-caps section labels are a single consistently-applied `h3.subhead` component, not drifting heading casing; and a document rendering as "undefined — text not extracted" traced to the **test harness's** mock data using stale field names (`content_type` rather than the real `media_type`), not to the live endpoint.

`assert_ui_audit_fixes.mjs` (25 assertions) covers all six, written against the behaviour the audit called out rather than against selectors — the scroll-fade states at both ends and in the middle, the active tab landing fully in view, the two badge tiers resolving to genuinely different computed colors, the Applied label, the answers section living outside `.split`, the column-balance ratio, Jindr's centring and title size, and the destructive treatment applying to Reset/Delete while an ordinary Remove stays quiet. Verified to fail when the badge-color and Applied-label fixes are reverted.

## Touch targets on iPhone

Every control in this file was sized for a mouse pointer, which is a few pixels wide. A fingertip is not. Apple's HIG puts the minimum at 44x44pt, and on an iPhone this app was shipping **row actions at 27px, the "N notes on file" disclosure at 20px, and primary buttons at 36px** — 69 undersized controls across the eleven tabs, at every phone width. That's the difference between tapping "Remove" and tapping the row above it.

The fix is one `@media (pointer: coarse)` block setting `min-height: 44px` on buttons, selects, inputs and summaries, with row actions and the tab bar called out separately (row actions were both the smallest and the most dangerous to mis-tap, sitting inches from a link that navigates away).

Three things about how it's scoped:

- **Gated on pointer type, not width.** An iPad in landscape is wider than a laptop window and still touched; a narrow desktop window is neither. A width breakpoint gets both of those backwards.
- **`min-height`, not `height`,** so anything already taller — a textarea, a button whose label wrapped to two lines — keeps the size it worked out for itself.
- **The desktop layout is untouched.** Its density was tuned deliberately; the test asserts the compact controls are still compact under a mouse, so this can't silently leak.

Checkboxes keep their small box and get the height on the surrounding `<label>` instead, since tapping the label is what toggles them. That uses `:has()`, which degrades to current behaviour on anything too old to support it rather than breaking.

`assert_touch_targets.mjs` (11 assertions) measures every control at 320/375/390/430px plus a tablet-landscape touch viewport, and asserts the mouse-pointer desktop keeps its compact sizing. Two measurement traps it deliberately avoids, both of which produced false passes on the way to it: keying findings by tag+class+text collapses four unlabelled checkboxes into one entry (reporting "1 remaining" when there were five), and crediting *every* control with its wrapping label's height passes a 36px select sitting under a two-line caption — only checkboxes and radios get that credit, because only they are actually toggled by a tap on the label.

## Secrets and credential handling

- `SETUP_SECRET` lives only in Cloudflare's Worker secret store (`wrangler secret put ... --env production`), never in Git, GitHub Actions secrets, or this repository.
- Device sessions store only a SHA-256 hash of the session token in D1 (`device_sessions.token_hash`), never the raw token.
- Enrollment codes store only a SHA-256 hash (`enrollment_codes.code_hash`), never the raw code.
- No Cloudflare API token, GitHub token, or model-provider key is ever sent to browser JavaScript.
- Automatic GitHub deployment uses Cloudflare Workers Builds' native Git integration, which does not require storing a Cloudflare API token in GitHub Actions secrets.
- `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` (see "Langfuse tracing" above) are Worker secrets like every other credential here — never committed, never sent to the browser. Every prompt and response this app sends is also sent to Langfuse when configured, exactly as it's already written to `llm_traces`, so treat a Langfuse project the same as the `/dev` console: real candidate data, not a throwaway debug feed.
- `ADZUNA_APP_ID`/`ADZUNA_APP_KEY` (see "Adzuna job-market discovery" above) are Worker secrets like every other credential here — never committed, never sent to the browser. Lower stakes than most: they authenticate a read-only job-search query, not access to any candidate data, and Adzuna never receives anything about the candidate beyond role/location search terms.
- Google OAuth Client ID/Secret (see "Gmail reply-checking" above) are normally entered through Settings → Email and stored in `candidate_profiles.google_oauth_json`, not as Worker secrets — `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env vars remain supported as an advanced/developer fallback. Either way, the Client Secret is never sent back to the browser once saved, never logged, and never appears in a trace or error message. The Gmail access/refresh tokens the flow obtains are stored separately in `candidate_profiles.gmail_json` — real credentials capable of reading the connected inbox, kept out of `preferences_json` specifically so neither column is ever included in `GET /profile`'s response to the browser.

### Deploy-before-migrate safety

Pushing to the repo triggers a Cloudflare Workers Build that runs `wrangler deploy` **and nothing else** — it does *not* run `wrangler d1 migrations apply`. Only the local `npm run release:production` script chains the two. That means a commit adding a migration plus the code depending on it ships the code to production while the column is still missing, and every query naming it fails until someone remembers to run migrations by hand. The deploy goes green; the breakage surfaces later as a runtime error on a feature nobody thought they'd touched.

`ensureSchema()` (`src/index.ts`) closes that window. It applies the `ADD COLUMN` statements this build's code depends on, once per isolate, swallowing the duplicate-column errors that are the normal outcome on an already-migrated database.

Two deliberate limits:

- **Additive only.** A nullable/defaulted new column is backward compatible in both directions — older code ignores it, newer code finds it — so running it early, twice, or against a database that already has it is harmless. Anything destructive or reshaping (drops, renames, backfills, table rewrites) does *not* belong here and stays a deliberate `wrangler d1 migrations apply` step, because those need a human deciding when they happen.
- **Migration files stay canonical.** `migrations/` remains the schema of record for provisioning a fresh database; `ADDITIVE_COLUMNS` is the safety net for databases that already exist. A new additive column goes in both, and `assert_ensure_schema.mjs` fails if anything in the guard is missing from a migration file.

The guard memoizes a *promise*, not a boolean. With a flag set before the awaits, a second request arriving mid-run would see "already checked" and proceed against a database that isn't ready — reintroducing the exact failure the guard exists to prevent. Every caller awaits the same promise instead.

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
