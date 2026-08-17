# Strengthen Profile

**Interested job → Strengthen Profile → Resume → Cover Letter → Apply.**

Using a real job the candidate wants as the prompt for remembering evidence their profile does not
yet hold.

## The idea

A generic "what's missing from your profile?" audit asks weak questions, because it has no basis for
preferring one gap over another. It ends up asking broad things about everything.

A specific posting supplies that ranking for free. It states which requirements matter; comparing
them against the candidate's record shows exactly where the record is thin. That turns an
open-ended interview into a short list of targeted, answerable questions.

The answers land in the **canonical profile**, not in a per-job scratchpad. So the second job starts
from everything the first one uncovered, and the number of questions is expected to *fall* over
time. That is the feature working, not running out of ideas.

## Stages

Implemented as explicit stages in `cloudflare/src/strengthen.ts`.

| # | Stage | Implementation | LLM task id |
|---|---|---|---|
| A | `analyze_job_requirements` | `philosophy.extractJobRequirements` | `resume.requirements` |
| B | `retrieve_candidate_evidence` | `philosophy.planEvidence` | `resume.plan_evidence` |
| C | `assess_requirement_coverage` | `philosophy.normalizePlan` (code-side verification) | — |
| D | `generate_clarification_questions` | `strengthen.generateClarificationQuestions` | `strengthen.questions` |
| — | **interrupt** — the candidate answers on the page | — | — |
| E | `extract_profile_updates` | `index.applyAnsweredQuestions` | `profile.improve_apply` |
| F | `merge_profile_updates` | same call — merge is the same operation | `profile.improve_apply` |
| G | `reassess_coverage` | re-runs B/C against the enriched profile | `resume.plan_evidence` |

Stages A–C already existed inside the resume builder and are **reused, not reimplemented**. What was
new is (D) turning graded gaps into questions, and persisting the result so it stops being thrown
away after every resume build.

Deterministic work stays deterministic. Requirement ids, the coverage enum, entity-id validation,
question deduplication and capping, ordering, and the anti-fabrication checks are all plain code.
Model calls are reserved for the three places semantic judgment is genuinely required: reading a
posting, matching evidence to requirements, and writing questions.

### Why not LangGraph

ApplyGo is a TypeScript Cloudflare Worker with no Python runtime and no LangChain dependency, and
[ADR-010](../decisions/index.md) defers durable-workflow-engine selection. Introducing LangGraph for
this one feature would mean standing up a second runtime beside the Worker — a parallel system.

What LangGraph would have been *for* is what the module already provides: named stages in a fixed
order, structured state persisted between them, a human interrupt in the middle, and per-stage
tracing. The stages are exported functions, D1 is the checkpoint store, the interrupt is the page
itself, and each stage carries its own task id so Langfuse groups it separately.

## Persisted state

### `job_evidence_analysis` (migration `0033`)

One row per posting, replaced in place on re-analysis. `analysis_json` holds the `JobEvidenceAnalysis`
structure: the extracted requirements, the graded coverage plan, and the fingerprint of the profile
the grading was computed against.

`requirements` and `plan` are stored as separate fields because they have different lifetimes:
requirements are a property of the *posting* (stable until the posting changes), while the plan is a
property of the posting *crossed with the current profile* (legitimately changes whenever the
profile gains evidence). That is why a reassessment recomputes the plan and reuses the requirements
— one model call, not two.

There is deliberately no history: an old grading of a profile that has since changed is misleading
rather than useful. Staleness is detected by comparing `profile_version` and surfaced in the UI as
an offer to re-analyze, never as a silent re-run — re-analysis costs money.

### `profile_improvement_questions` (extended by `0033`)

Questions stay in the **profile-wide** table rather than getting a job-scoped one. This is the single
most important schema decision in the feature.

The cumulative-benefit property depends on there being exactly one question history per candidate,
queried across every job. A per-job questions table would make each posting start from zero — the
precise opposite of the intended behavior. So `job_id` records *provenance* (which posting prompted
this question), not ownership, and `requirement_id` links a question to the requirement it chases.

Consequences that fall out of this, all intended:

- A question answered for job A is visible to job B's generator and is not re-asked.
- "I haven't done this" (`dismissed`) is durable and profile-wide, so no later posting asks again.
- Deleting a posting sets `job_id` to `NULL` and keeps the question and its answer. The evidence the
  candidate remembered is theirs; it should not evaporate because they deleted the posting that
  jogged their memory.

## Truthfulness

The system may infer that existing evidence *might* be relevant, ask whether the candidate did
something, and ask for missing detail. It may not silently upgrade adjacent experience into exact
experience, or manufacture metrics, responsibilities, scale, seniority, production usage,
technologies, outcomes, leadership, customers, deployments, or credentials.

Two code-side checks enforce the part that matters (`philosophy.normalizePlan`):

1. **Evidence must trace back to the profile.** A `proven` claim whose cited text shares almost no
   vocabulary with the record is demoted.
2. **The requirement's own distinctive vocabulary must appear in the record.** Check 1 alone asks
   only "is this evidence real?" — which a model satisfies while citing the wrong thing when it
   quotes genuine Plotly work as proof of a `D3.js` requirement. Check 2 demotes that to `partial`:
   real adjacent experience exists, it is not the named thing, and the question generator is then
   free to *ask* about D3.js without anything having claimed it.

If the candidate says no, the gap is preserved. A truthful missing qualification is better than a
fabricated match, and nobody satisfies 100% of a posting.

## Provenance

Evidence can be traced to where it came from: uploaded documents and notes (via the Create pass),
manual profile entry, a profile-wide Improve answer, or a Strengthen clarification for a particular
job (`profile_improvement_questions.job_id` plus `requirement_id`/`requirement_text`).

## Downstream consumers

Both writers read the same saved artifact instead of re-deriving it, which saves two model calls per
build and — more importantly — makes them agree with the coverage the candidate was just shown
rather than forming a second, possibly conflicting opinion.

**Resume** (`loadEvidencePlan` → `renderPlanDirective` → `resume/compose`) receives the complete
structured profile, the job description, the requirement analysis, the evidence mapping, the
per-role feature/include/compress/omit budget, requirement coverage split into
must-be-visibly-supported / partially-supported / prohibited, and the canonical `RESUME_GUIDANCE`.

**Cover letter** (`renderCoverLetterEvidence` → `cover_letter/compose`) receives the profile, the job
description, the role summary, the strongest verified connections ranked by how important the
employer says they are, partial matches flagged as do-not-overstate, unproven requirements as an
explicit prohibition, and the candidate's job-specific clarifications. It is told to develop two or
three connections rather than paraphrase the resume.

Neither is gated on the analysis existing. A posting the candidate never ran Strengthen Profile on
still produces a resume and a letter exactly as before — the analysis grounds them when present.

## Backward compatibility

Analysis is **lazy**: nothing is analyzed until the candidate opens Strengthen Profile for that job.
This keeps the feature affordable when twenty jobs are marked interesting in one sitting, and makes
it safe to ship against a database already full of postings. Every read path treats a missing
analysis as a normal state rather than an error, and the `0033` migration is purely additive.

## What was removed

The Profile tab's generic **Improve** subtab and the Interested job's freeform **Ask a question**
box are both gone, superseded by this workflow.

The machinery underneath them was not deleted. The question table, the apply/merge pass, and the
`/profile/improve/*` endpoints are what Strengthen Profile actually runs on, and the
`/jobs/:id/review` endpoints still serve the browser extension and the application-answer generator.
