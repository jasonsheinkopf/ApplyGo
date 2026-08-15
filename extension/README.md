# ApplyGo application assistant (browser extension)

An in-page agent that works down a job application with you: it fills what ApplyGo already knows,
asks when it genuinely needs you, offers to draft a narrative answer from your real experience when
you ask for one, remembers the answers worth remembering, and checks the finished form. **It never
submits anything, and it never leaves a field silently skipped** — a field the agent can't resolve on
its own stays visibly outstanding until you fill it, save it, or (only when the employer's own form
marks it optional) explicitly leave it blank.

## The flow it's built for

ApplyGo finds the job → you mark it Interested → ApplyGo prepares the tailored resume and cover
letter → you press **Apply** on the Interested card → the employer's application opens → a small
ApplyGo tab appears on the right edge → you open it and press **Autofill application**.

Applications for jobs that never went through ApplyGo still work (it fills from your profile), but
the job-specific parts — the tailored resume, the cover letter, answers you gave for that job — only
exist when the job came from ApplyGo.

## Why an extension and not the server

ApplyGo already runs a headless browser (Cloudflare Browser Rendering) to render resume PDFs, so
the obvious idea is to have the server fill out application forms too. That does not work reliably:

- Cloudflare's browsers run from datacenter IPs, which ATS bot detection flags.
- CAPTCHAs end the attempt with no way to continue.
- Workday and similar require an account and a logged-in session.
- There is no way for you to step in when something goes wrong mid-run.

Running in your own browser solves all four at once. You are already logged in where it matters,
the traffic looks exactly like you (because it is you), and when a CAPTCHA appears you solve it in
two seconds. It also reads the live DOM, so it works on job boards ApplyGo has never seen rather
than only the four ATS platforms it knows how to scan.

## Why in the page and not the popup

A Chrome popup closes the instant you click back into the form. An assistant that follows an
application from the first field to the final review has to stay on screen while you scroll and
read, so the UI is injected into the page as a collapsible right-edge panel. The popup is now only
what a popup is good at: a one-time connection step.

## Architecture

| File | Role |
|---|---|
| `background.js` | The only network path. Content scripts can't call the Worker directly (an MV3 content-script fetch carries the *page's* origin, and the Worker only sends CORS headers to `chrome-extension://` origins — a boundary worth keeping). A service-worker fetch runs under `host_permissions` and isn't subject to page CORS. It also means the bearer token never exists in the world running on an employer's page. |
| `content.js` | The DOM layer, and the **only** thing that mutates the page. Reads fields, fills them, scrolls, highlights, verifies, attaches the resume, reads validation errors. Decides nothing. |
| `shiba.js` | The agent's face: original flat-vector Shiba Inu with one look per state (ready, thinking, working, asking, done, attention). No animation, nothing to fetch. |
| `agent.js` | The orchestrator. Owns the structured application state, sequences the work, verifies every fill, re-reads the page when it changes, asks when it must, and runs the final review. |
| `sidebar.js` | The injected UI, in a shadow root so the employer's stylesheet can't reach in and ApplyGo's can't leak out. Edge tab ⇄ panel. |
| `popup.js` | Connect / disconnect / force the panel open. |

### Deterministic by default, agentic at the boundaries

The agent does not read every field and send one big prompt. It works down a resolution order where
each tier is cheaper and more trustworthy than the next:

1. answers you gave for **this specific job**
2. explicit saved answers (the answer bank)
3. deterministic profile facts — name, email, phone, LinkedIn
4. the tailored resume and cover letter the main app prepared
5. ask you — offering to draft an open-ended answer on request, never inventing one automatically

Tiers 1–4 are lookups and cost nothing. No model call is ever spent deciding that your first name
goes in the first-name field, and there is no automatic model pass over whatever's left. Tiers 1–4
resolve inside `POST /applications/match` on the Worker, which is where your profile lives; a draft
for tier 5 is its own on-demand call (`POST /applications/generate-answer`, triggered only by you
pressing **Generate**) that lands in the sidebar's editable textarea, never straight into the
employer's form. The agent's own job is everything around those calls — sequencing, executing,
verifying, noticing the page changed, and knowing when to stop.

### A constrained tool set

The model never gets direct control of the browser. The agent may only take the actions in
`agent.js`'s `tools` object — inspect the page, scroll to a field, highlight it, fill it, verify it,
upload the resume, fill the cover letter, ask you something, draft an answer, save an answer, report
completion. Deterministic code in `content.js` executes every one of them. That buys agentic
reasoning without an unrestricted browser agent.

### It watches what it did

Every fill is verified against the live DOM before it counts. Forms reject values, reformat them
(a phone mask), or silently revert them (a controlled React input), and a fill that reports success
without checking is how a half-empty application gets called finished. A value that didn't survive
is marked *didn't stick* and surfaced, not counted.

### It re-reads the page

Selecting a country can reveal a work-authorization question; uploading a resume can populate five
fields at once. After each pass the agent re-scans, diffs against what it knew, and plans another
round for anything that appeared (capped at three rounds). Fields already triaged are never sent
back through the model.

## What it will not guess

Work authorization, sponsorship, citizenship, veteran status, disability, gender, race, criminal
history, salary expectations, notice period, start date, relocation, and security clearance never
reach the model — no autofill, and no **Generate** button either. These are legally or personally
consequential and a confident guess is worse than no answer. Either your answer bank already has an
explicit answer you gave before, or the Shiba asks you directly. That rule lives in `NEVER_INFER` in
`cloudflare/src/index.ts`, and `POST /applications/generate-answer` checks it again on the server
rather than trusting the sidebar's own gating.

## Generate, Fill, Save

For an open-ended question your evidence can actually support — "why this company," "tell us about
your ML experience" — the sidebar offers **Generate**: a focused draft grounded in your profile,
resume history, this job's description and company, and any job-specific notes you've already given,
never fabricating experience, credentials, dates, or employers. The draft lands in an editable
textarea, never straight into the employer's form — **Generate → read it, edit it → Fill or Save.**

Two actions, not one ambiguous "remember this?":

- **Fill** — use this answer on this application only. Nothing new is remembered.
- **Save** — use it now *and* remember it, scoped to where it actually belongs (see below). The
  sidebar confirms what happened in plain terms, e.g. *"Filled and saved for future Anthropic
  applications."*

There's no generic Skip. A fixed-choice question (Yes/No, a dropdown) only ever shows the employer's
real options — never an invented one — and choosing an option fills it immediately, with a small
checkbox to also save it. A field only gets a **Leave blank** option when the employer's own form
marks it optional; a required field always stays outstanding until you answer it.

## What it remembers, and what it doesn't

Not every answer belongs in a permanent bank. When you Save something, the Worker classifies it
(`classifyAnswer` in `cloudflare/src/index.ts`) and stores it accordingly:

| Category | Example | Where it goes |
|---|---|---|
| Stable fact | phone number, work authorization | answer bank |
| Preference | willing to relocate, remote/hybrid | answer bank |
| Contextual | salary expectation, notice period | answer bank, flagged as liable to go stale |
| Job-specific | "why do you want to work at Acme?" | stored against that job only, never reused elsewhere |
| One-time | agree-to-terms, referral source | not stored — Save says so honestly |

Since Save is itself your explicit "remember this" signal, there's no separate ask-to-remember step —
anything the rules don't otherwise recognise goes straight into the bank when you save it.

If your new answer contradicts a saved one, it says so and asks whether to update the saved copy.
Your current answer always governs the application in front of you; the stored one only changes when
you say so.

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked**, select this `extension/` directory.
3. In ApplyGo, go to **Settings › Devices** and create an enrollment code.
4. Click the extension icon, paste the code, confirm the ApplyGo URL, and press **Connect**.

The URL must match the ApplyGo you made the code in. A code from `npm run enroll:local` only exists
in your local database — pair it with `http://localhost:8787`, not the production URL.

The extension enrolls as its own device, so it appears in Settings › Devices and is revoked there
like any other. No store listing and no Google review are involved, because this is loaded unpacked
for one person.

## Supported sites

Greenhouse, Lever, Ashby, and SmartRecruiters are wired up in `manifest.json`. Adding another is a
matter of adding its URL pattern to both `host_permissions` and `content_scripts.matches`; the
form-reading code itself is not vendor-specific.

The panel only offers itself on pages that actually look like an application (several fields, at
least one of the things every application asks for), so it stays out of the way on listing and
search pages on the same domains.

## Audit trail

The agent records its decisions — field detected, which tier answered it, whether the value stuck,
what you were asked, what got stored, contradictions, the final review — to
`application_agent_events` via `POST /applications/events`. Values are dropped for anything
`NEVER_INFER` matches. The point is to make the agent inspectable and, later, evaluable.
