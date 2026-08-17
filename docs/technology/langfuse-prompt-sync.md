# Langfuse Prompt Sync

The canonical answer to: **which prompts has the repository changed, and what still needs to be
pushed to my live Langfuse account?**

## The one instruction

Hand this to a coding agent (or run it yourself) once you have your Langfuse credentials available:

> **Sync all locally changed ApplyGo prompts to Langfuse.**

That resolves to:

```bash
cd cloudflare
npm run prompts:check   # dry run: shows exactly what is missing, stale, or edited. Writes nothing.
npm run prompts:sync    # creates/updates the prompts that need it, labeled production
```

Credentials come from the environment, the repository `.env`, or `cloudflare/.dev.vars` — all
gitignored. **No secret belongs in source control.**

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com     # Japan-region projects: https://jp.cloud.langfuse.com
```

Both commands are safe to repeat. When everything is current, `prompts:sync` makes no writes at all.

## Why this can be one command

[`cloudflare/src/prompts.ts`](../../cloudflare/src/prompts.ts) is already a machine-readable
registry: `PROMPT_DEFAULTS` maps each **Langfuse prompt name** to its canonical text plus a
`requires` list naming the variables a template must reference to count as current.

[`scripts/sync-langfuse-prompts.mjs`](../../cloudflare/scripts/sync-langfuse-prompts.mjs) imports
that registry directly — it does not parse the file or keep a duplicate copy, because either would
reintroduce exactly the drift this mechanism exists to prevent. It then applies the *same*
staleness rule the runtime applies (`isPromptCompatible` in `src/langfuse.ts`), so the report always
matches what the app will actually do.

There is therefore no separate list to keep up to date, and no step where a human decides what
"changed". Adding a prompt to `PROMPT_DEFAULTS` is what puts it in scope.

## What the statuses mean

| Status | Meaning | Synced by default |
|---|---|---|
| `NEW` | The prompt does not exist in Langfuse at all. | Yes |
| `STALE` | It exists but references none of its `requires` variables, so it predates the current code. The runtime is already ignoring it in favor of the bundled text. | Yes |
| `edited` | It is current *and* differs from the repository text — someone deliberately edited it in Langfuse. | **No** — use `--all` to overwrite |
| `ok` | Byte-identical to the repository text. | No |

`edited` is not synced by default on purpose. Langfuse is where prompts are *meant* to be revised
without a deploy; silently clobbering a deliberate improvement is the worst thing a sync tool can do.

## Current state of every registered prompt

As of this change. Run `npm run prompts:check` for live status — this table is a snapshot, the
script is the truth.

| Langfuse name | Local source (`cloudflare/src/prompts.ts`) | State | Needs sync? |
|---|---|---|---|
| `job/strengthen-questions` | `STRENGTHEN_QUESTIONS_PROMPT` | **new** | **Yes — does not exist in Langfuse** |
| `cover_letter/compose` | `COVER_LETTER_COMPOSE_PROMPT` | **modified** (new `job_analysis` variable) | **Yes — live version is now stale** |
| `profile/create` | `PROFILE_CREATE_PROMPT` | unchanged | No |
| `profile/improve-audit` | `PROFILE_IMPROVE_AUDIT_PROMPT` | unchanged | No |
| `profile/improve-apply` | `PROFILE_IMPROVE_APPLY_PROMPT` | unchanged | No |
| `roles/analyze` | `ROLES_ANALYZE_PROMPT` | unchanged | No |
| `roles/research` | `ROLES_RESEARCH_PROMPT` | unchanged | No |

### Prompts changed outside the registry

| Langfuse name | What changed | Needs sync? |
|---|---|---|
| `resume/compose` | **Nothing in Langfuse.** The canonical resume guidance now reaches it through the existing `plan_directive` variable, assembled in `composeDirective` (`src/resume.ts`). | **No** |

That last row is a deliberate design choice. `resume/compose` is large, layout-coupled, and lives
only in Langfuse; adding a required variable would mark the live version stale and swap in a bundled
replacement written without sight of the current text. Routing the guidance through the slot that
already means "pre-decided instructions the writer must follow" gets it in front of the model today,
with no Langfuse change and nothing to regress.

## Variables each changed prompt expects

The runtime fails loudly (`langfuse_prompt_missing_variables`) if a template references a variable
the code does not send, so a synced template must use exactly these names.

### `job/strengthen-questions` — new

| Variable | Contents |
|---|---|
| `job_title`, `company` | The posting being analyzed. |
| `role_summary` | One-sentence plain-language description of the role. |
| `requirement_coverage` | Each requirement with id, kind, graded status, and the evidence found. |
| `career_profile` | The full rendered career evidence record. |
| `profile_entity_ids` | `entity_type \| entity_id \| label` per line — the only ids a question may target. |
| `prior_question_state` | Every question asked before, across all jobs, with status and answer. |
| `resume_guidance` | The canonical `RESUME_GUIDANCE` constant, so questions chase resume-grade evidence. |

Structured output: `STRENGTHEN_QUESTIONS_SCHEMA` (`src/strengthen.ts`), tool `submit_questions`.
Task id `strengthen.questions`.

### `cover_letter/compose` — modified

| Variable | Contents |
|---|---|
| `job_analysis` | **New.** Verified requirement/evidence mapping: strongest connections, partial matches, and prohibited claims. Empty string when the job was never analyzed. |
| `job_title`, `company`, `job_description` | Unchanged. |
| `review_answers` | Unchanged — the candidate's job-specific clarifications. |
| `contact_line` | Unchanged. |
| `candidate_profile` | Now the *rendered* career record rather than raw JSON. |

Structured output: `COVER_LETTER_SCHEMA` (`src/index.ts`), tool `submit_cover_letter`. Task id
`cover_letter.write`.

## Until you sync

Nothing is broken in the meantime, and this is the point of the bundled-defaults mechanism:

- `job/strengthen-questions` does not exist in Langfuse, so the bundled text is used.
- `cover_letter/compose`'s live version no longer references `job_analysis`, so it is treated as
  stale and the bundled text is used.

Both are served with the name `<name> (bundled default)` and version `0`, so it is obvious in a
Langfuse trace which calls are running on repository text rather than a managed prompt. Once you
sync, Langfuse wins again and the bundled copies go dormant.

### One caveat worth knowing

`requires` is evaluated with `.some()` — a template counts as current if it mentions **any** listed
variable. So a prompt's `requires` list must name only variables that are genuinely new to that
change. `cover_letter/compose` lists `job_analysis` alone for exactly this reason: adding
`candidate_profile` (which every previous version already referenced) would make the live prompt
pass the staleness test forever, the bundled text would never be served, and cover letters would
quietly keep being written with no coverage report. There is a regression test for this in
`src/strengthen.test.ts`.

## Rolling back

The script only ever creates new versions. Langfuse retains every previous one, so an unwanted push
is undone by re-promoting the older version to `production` in the Langfuse UI — not by anything in
this repository.
