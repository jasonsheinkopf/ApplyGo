# Chat Agent API

ApplyGo now has a narrow agent-facing API so a trusted conversational agent can maintain the same candidate record the web/mobile UI uses.

The design rule is **one source of truth**. There is no chat-specific career database. Agent writes land in the existing Cloudflare D1/R2 model:

- `candidate_profiles` for candidate preferences and the generated structured profile
- `candidate_evidence` for factual notes and Career preference notes
- `source_documents` + the existing `FILES` R2 bucket for resume/supporting-document text
- existing Profile generation and Career analysis routes for derived data

The agent-specific tables contain only access-control, interview-progress, and audit metadata.

## Why this is a gateway instead of direct D1 access

A model should not receive a database credential or arbitrary SQL capability. The Worker is the policy boundary: it translates a small set of agent intentions into the same application data structures the UI already understands.

```mermaid
flowchart LR
    C[Chat / job agent] -->|ago_* bearer token| G[Agent gateway]
    U[ApplyGo web/mobile UI] --> W[Existing Worker]
    G --> D[(D1)]
    G --> R[(R2)]
    G -->|allowlisted internal bridge| W
    W --> D
    W --> R
```

`cloudflare/src/agent-gateway.ts` is now the Wrangler entry point. Every non-`/agent` request is delegated unchanged to the existing `src/index.ts` Worker. This keeps the existing product behavior intact while adding the new surface independently.

## Security boundary

Agent credentials intentionally do **not** use `device_sessions`.

The existing app only distinguishes `read_only` from everything else; a new scope stored there would currently be treated like a full session by legacy routes. Instead, agent tokens are stored as SHA-256 hashes in `agent_credentials` and are recognized only under `/agent/v1/*`.

Properties:

- raw token prefix: `ago_`
- raw token returned once at creation
- only the hash is persisted
- expiration: 1–365 days, 90-day default
- independently revocable from `/agent`
- no Cloudflare API token, D1 credential, setup secret, or model-provider secret is exposed
- agent activity stores action names and short summaries, never raw resumes/notes or bearer tokens

Profile generation and Career analysis are existing ApplyGo actions rather than duplicated implementations. The gateway invokes only those two allowlisted legacy routes through a short-lived internal full session that is deleted immediately after the call. The external agent never sees that internal token.

## UI

A signed-in user can open `/agent` to:

- create an agent key
- copy the key once
- see and revoke active keys
- see current onboarding progress and the next interview question
- start a fresh interview

The gateway also injects a **Manage agent access** link into Settings > Devices on the existing dashboard, without modifying the large inline dashboard template in `index.ts`.

“Start fresh” is non-destructive. It resets only the interview confirmation flags. Existing documents, profile data, companies, jobs, applications, and generated artifacts remain in place.

## Agent API v1

All agent-data routes accept `Authorization: Bearer ago_...`. The same routes can also be used by a signed-in full dashboard session, which is how the `/agent` management page reads status.

### Read context

`GET /agent/v1/context`

Returns:

- profile summary and user-authored preferences
- source-document metadata
- Career preference notes
- factual notes
- whether a structured profile and role analysis exist
- interview confirmation flags
- ordered remaining questions
- a deterministic `next_action`

Use `?full=1` when the caller genuinely needs the complete structured profile and raw preferences.

Possible `next_action` values:

1. `continue_onboarding`
2. `generate_profile`
3. `analyze_careers`
4. `ready_for_job_search`

### Start or continue onboarding

`POST /agent/v1/onboarding/start`

```json
{ "mode": "fresh" }
```

`fresh` re-asks every onboarding topic without deleting canonical data. `continue` infers completed topics from the existing record.

`POST /agent/v1/onboarding/confirm`

```json
{ "topic": "extra_evidence" }
```

Use confirmation for a valid empty answer such as “no dealbreakers” or “nothing else to add.”

### Resume/supporting text

`POST /agent/v1/documents/text`

```json
{
  "name": "resume.pdf",
  "kind": "resume",
  "text": "extracted resume text..."
}
```

The gateway stores the content as a real `.txt` object in R2 and creates a normal `source_documents` row, so it appears in the existing Documents UI and is read by normal Profile generation. The filename is changed to `.txt` so the stored media type is never misrepresented as PDF/DOCX.

### Career preference notes

`POST /agent/v1/career-preferences`

```json
{ "text": "I want applied AI / agentic product engineering roles..." }
```

This writes the same `candidate_evidence.category='role_signal'` rows used by the Career UI. It invalidates stale derived role analysis.

### Search constraints and comparison priorities

`PUT /agent/v1/preferences`

```json
{
  "desired_locations": "Northern or Southern California, plus US remote",
  "dealbreakers": "Reject remote roles below ...",
  "care_about": "Compensation, remote policy, years required"
}
```

Only these user-authored fields are accepted. Existing unrelated preference keys are preserved. If a changed input makes `role_analysis`, `desired_roles`, or `care_about_topics` stale, the gateway removes those derived values so they are regenerated rather than silently reused.

### Factual evidence

`POST /agent/v1/notes`

```json
{ "text": "At Bosch I built ..." }
```

Writes the same normal `candidate_evidence.category='note'` data the Profile > Notes UI uses.

### Derived profile and career analysis

`POST /agent/v1/profile/generate`

```json
{ "provider": "anthropic" }
```

`POST /agent/v1/careers/analyze`

```json
{ "provider": "anthropic" }
```

These delegate to the existing `/profile/generate` and `/desired-roles/analyze` implementations through the private internal bridge.

### Credential management

These require a normal full ApplyGo dashboard session, not an agent token:

- `GET /agent/v1/tokens`
- `POST /agent/v1/tokens`
- `DELETE /agent/v1/tokens/:id`

`GET /agent/v1/activity` is available to either a full dashboard session or a valid agent credential.

## Initial interview contract

A fresh agent should ask these topics in order and write each answer immediately:

1. **Resume** — current resume/CV source text
2. **Career direction** — jobs/work the candidate wants next
3. **Locations** — remote/hybrid/onsite/relocation and geography
4. **Dealbreakers** — binding exclusions, including compensation/seniority if relevant
5. **Priorities** — facts the candidate wants surfaced when comparing jobs
6. **Extra evidence** — important career facts the resume omitted

After the six topics are confirmed, the agent follows `next_action`: generate the canonical structured profile, then analyze Career role families, then begin job discovery.

## Job search, evaluation, profile feedback, and materials (v1.1)

The slice above intentionally stopped at `ready_for_job_search`. Everything below extends the same
`/agent/v1/*` surface, under the same `ago_*` bearer auth, to cover the rest of the workflow the
website's Companies/Jobs/Profile/Interested tabs already expose. Every route is a thin translation
over an existing legacy route -- discovery, scoring, and generation are not reimplemented here, only
gated and reshaped for a single-shot tool call instead of a browser session.

**Hard boundary, unchanged:** none of these routes submit an application or contact an employer.
ApplyGo has no automated-submission route at all today -- `/applications/*` backs a browser-extension
autofill flow, not automated submission -- so that boundary holds by omission, not by a check that
could be bypassed.

### Streaming legacy routes become one summarized result

`/companies/scan`, `/companies/discover`, `/jobs/process`, and `/profile/improve/audit` report
progress to the browser as NDJSON (one JSON object per line) so a long-running scan can show live
counts. An MCP tool call gets one result, not a stream, so every wrapper below collapses that into
a single object: `event_counts` (a tally by `type.stage.phase`), `errors` (up to the first 10 failed
events), `final_event`, and `total_events`. A route that never streamed (most `GET`/`PUT` routes)
passes its JSON straight through unchanged.

### Companies

- `POST /agent/v1/companies/discover` -- wraps `POST /companies/discover`.
- `POST /agent/v1/companies/scan` -- wraps `POST /companies/scan`.
- `GET /agent/v1/companies/search-terms` / `PUT /agent/v1/companies/search-terms` -- wrap the same-named legacy routes.

### Jobs

- `POST /agent/v1/jobs/search` -- there is no discovery primitive independent of the company
  pipeline (new companies come from `/companies/discover`; new postings come from scanning them).
  This runs `/companies/scan` then the fit pipeline, and reports only postings whose `created_at`
  is at or after when the call started: `{ scan, evaluate, newly_found_count, newly_found }`.
- `POST /agent/v1/jobs/process` -- thin wrap of `POST /jobs/process` (the bulk screen-then-assess
  pipeline over whatever is currently `unassessed`). Body: `{ provider?, calls? }`.
- `POST /agent/v1/jobs/evaluate` -- runs the same pipeline, then returns a ranked, rationale-rich
  shortlist rather than raw scores: `{ pipeline_run, ranked: [{ id, title, company, location,
  fit_score, fit_reason, missing, url }] }`. Body adds `min_score` (default 40) and `limit`
  (default 20) on top of `jobs/process`'s fields. There is no narrower "score just this job"
  primitive in the app -- the pipeline only ever touches `unassessed` rows, so it is safe to call
  repeatedly and cheap when nothing new is waiting.
- `GET /agent/v1/jobs/shortlist?min_score=&limit=` -- read-only version of the ranked list above,
  without triggering a pipeline run first.

### Profile feedback loop

The task's "surface gaps as targeted questions" loop is the existing Profile > Improve workflow
(`profile_improvement_questions` / `profile_improvement_audits`, feeding confirmed answers into
`candidate_evidence`), exposed as four routes rather than one, matching the legacy route shapes:

- `GET /agent/v1/profile/questions` -- wraps `GET /profile/improve/questions`.
- `POST /agent/v1/profile/questions/audit` -- wraps `POST /profile/improve/audit` (finds new gaps
  between the profile and the jobs it's been matched against).
- `PUT /agent/v1/profile/questions/:id` -- wraps `PUT /profile/improve/questions/:id` (answer one
  question).
- `POST /agent/v1/profile/questions/apply` -- wraps `POST /profile/improve/apply` (commits answered
  questions into `candidate_evidence`).

### Application materials

- `POST /agent/v1/materials/resume` -- body `{ job_id, provider?, regenerate? }`, wraps
  `POST /jobs/:id/resume`. Generation reads `candidate_evidence`/`source_documents` exactly as the
  website's Interested tab does; nothing here gives the model latitude to state a qualification the
  profile doesn't back.
- `POST /agent/v1/materials/cover-letter` -- same shape, wraps `POST /jobs/:id/cover-letter`.

### Pipeline status (QC)

`GET /agent/v1/pipeline/status` answers "why aren't we finding enough good jobs": the same
company/job funnel the dashboard renders (via `pipeline.ts`'s `companyFunnel`, so the arithmetic is
guaranteed to reconcile -- `funnel_violations` is empty on a healthy pipeline), plus three signals a
funnel count alone can't show: `model_call_failures_24h` (from `llm_traces`),
`discovery_streams_with_pages_remaining` (from `company_discovery_streams`), and
`duplicate_title_company_groups` (postings that collided on title+company).

## Current product integration note

The Agent API is the stable backend contract; MCP is an adapter, not the data model. The existing
`mcp/` server is a **local, stdio, read-only** server for Claude Desktop/Code, authenticated with a
manually-copied `read_only` device token -- it is not reachable by a Claude.ai web Connector, which
requires a remote HTTP server speaking OAuth 2.1 with dynamic client registration. That remote,
write-capable server is `/mcp/*` on this same Worker (see `docs/architecture/mcp-connector.md`); it
calls this Agent API's routes as its tool implementations rather than duplicating any of the logic
above.
