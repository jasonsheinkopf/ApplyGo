# ApplyGo — working notes

## Operating this repo from a Claude session

**Adding an MCP tool mid-session drops the connector.** When a new tool is added to
`cloudflare/src/mcp-server.ts` and deployed, the Apply Go connector can disconnect for the session
that is running — the observed cause is that the new tool has no standing permission, and it is not
covered by the tools the user previously approved. Two consequences worth planning around:

- A session's MCP tool list is fixed when the session starts. Re-attaching the connector restores
  the *old* list; a tool added after the session began stays uncallable until a new session. Route
  new capability through a parameter of an existing tool where possible — `task` and `model` on
  `run_prompt_experiment` were used exactly this way to reach a new replay spec without needing a
  new tool to be callable.
- Ship tool additions at the end of a work session, not the middle, and expect the next session
  rather than this one to be able to use them.

**There is no `CLOUDFLARE_API_TOKEN` in the session environment.** `wrangler d1 execute --remote`
and any other authenticated wrangler command will fail. Use the Cloudflare MCP D1 query tool, and
keep single statements small enough to write by hand — large payloads belong in
`cloudflare/evidence/` in git, referenced from the database row.

**D1 columns that are NOT NULL and easy to trip over:** `job_postings.fit_reason`,
`job_postings.fit_detail_json`. Resetting a posting for re-assessment must set `fit_status` and
`assessed_at` only; nulling either of those fails the statement.

**`fit_score_previous` holds one prior reading.** Re-scoring twice loses the middle one. Snapshot
before the second pass if all three readings matter.

**Prompt variables must be strings.** `compilePrompt` substitutes with `String(value)`, so a JSON
array or object stored in `eval_cases.variables_json` renders as `[object Object]` and the model
receives a prompt with the data silently missing. It does not error — the model answers the prompt
it was actually given, which is how a reference run once returned an empty result set that looked
like a model failure. When building variables in SQL, concatenate to TEXT (`'[' || group_concat(...)
|| ']'`) so `json_set` stores a string rather than a JSON array.

**Extended thinking: `budget_tokens` is rejected, not deprecated, on current models.** Opus 5,
Sonnet 5, Opus 4.6+ and Fable 5 take `thinking: {type: "adaptive"}` with
`output_config: {effort: ...}`. Sending the older `{type: "enabled", budget_tokens: N}` returns a
400. Pre-4.6 models still require the budget form. Load the `claude-api` skill before writing any
Anthropic request code — this exact drift is in its table, and writing it from memory cost a full
round of failed Opus calls.

**`ctx.waitUntil` will not carry a long model call.** Background work dispatched from the fetch
handler is reclaimed before a multi-minute call returns: no row is written, no error is raised, and
the record sits at `running` for ever. Short calls on the same path complete fine, and the
*scheduled* handler runs much heavier work reliably — so the limit is specific to background work
started from a request. Long work belongs in a bounded synchronous loop the caller re-invokes
(`advanceExperiment`, `evaluate_jobs`), with progress derived from what is already recorded rather
than from a stored cursor.

## Evidence and decisions

Measurements go in `evidence_records`, changes in `decision_records` (migration 0038, helpers in
`cloudflare/src/evidence.ts`). Raw per-item data goes in `cloudflare/evidence/<slug>.json` and is
referenced from `provenance_json.raw_data_file`. Confidence and limitations are stored apart from
the conclusion so a tentative finding cannot later be quoted as settled. An overturned finding is
marked superseded, never edited.

Prefer deterministic metrics. Use the LLM judge only where they cannot decide — `selectDisagreements`
exists to spend that budget on the cases that can still change an outcome.

## Model tiers

`screen` reads a title and location and answers yes/no; `reason` reads the whole posting and scores
it. They are configured separately (`*_SCREEN_MODEL` vs `*_MODEL`) and should be chosen separately:
the screen tier is a cheap classification where model quality buys little, and the reason tier is
where it decides what the candidate sees. `fit.reference_rank` is the deliberately expensive task
used to build a reference ranking, not to score daily volume.
