# Reference-ranking benchmark — ready to run

Everything that can be prepared without model access is prepared. What remains needs a session
holding the **Apply Go** MCP connector (`run_prompt_experiment`).

## State as of 2026-08-30 07:40 UTC

**Staged in D1 (`eval_cases`, task `fit.reference_rank`), 25 postings across 3 cases:**

| case | postings | note |
|---|---|---|
| Reference ranking chunk 1 of 3 - postings 1-9 | 9 | ranks 1–9 by production `fit_score` |
| Reference ranking chunk 2 of 3 - postings 10-17 | 8 | ranks 10–17 |
| Reference ranking chunk 3 of 3 - postings 18-25 | 8 | ranks 18–25 |

All three share one variable envelope (`candidate_profile`, `hard_constraints`, `role_targeting`,
`lived_experience`, `past_rejections`) and differ only in `postings`. Descriptions are truncated to
2200 characters in every chunk so the arms stay comparable. `json_type(variables_json,'$.postings')`
is `text` in all three — see CLAUDE.md on why that matters.

Chunked deliberately: one 25-posting prompt is a single very long deliberative call, and three
smaller ones fit the bounded runner (`advanceExperiment`, PR #126) without any one call dominating.
Scores are still comparable across chunks because the rubric and context are identical; only
*within-chunk* relative calibration is guaranteed, which is a limitation to record.

**Experiments:** all five earlier `fit.reference_rank` experiments are renamed `VOID …` and set to
`failed`. They hold no usable data — two arms 400'd on the old thinking parameters, two returned
empty because of the `[object Object]` variable bug. Rows preserved in
`ev-2026-08-30-reference-ranking-void-attempts.json`. Start new experiments under new names; the
runner resumes by name, so reusing an old one would skip the work.

## To run

Two experiments, each swept across all three cases, both using the two variants recorded in the
void-attempts file's sibling notes (control = rich context, production-context = the lean prompt):

- **A** — `anthropic` / `claude-opus-5`, effort `high`
- **B** — `openai` / `gpt-5.6-sol`, high reasoning

Call `run_prompt_experiment` repeatedly with the same name and task, `max_calls: 1`, until
`remaining_calls` is 0. Twelve calls total (2 experiments × 2 variants × 3 chunks).

## Pre-registered hypothesis

Production treats all of California as equally acceptable, but the targeting document ranks Orange
County / Irvine first, Southern California second, Bay Area third — and all 25 postings are San
Francisco. It also ranks industries (medical devices, then automotive, robotics, industrial) and
prefers AI applied to physical products over enterprise software, while this set is mostly dev tools
and enterprise AI. The rich-context arm should therefore reorder the top of the board and push
dev-tools roles down. If the two arms agree closely, the extra context is *not* doing the work — a
real result, and a cheaper reference than assumed.

## Then

Spearman between the two references; each production model (sonnet-5, gpt-5.6-terra, rows in
`ev-2026-08-30-reason-tier-sonnet5-vs-gpt56terra.json`) against each reference; rich vs production
context within each model. Write `ev-2026-08-30-reference-ranking-benchmark` with raw rows here and
`provenance_json.raw_data_file` pointing at them.

Limitations to record separately from any conclusion: two model opinions are a silver standard, not
ground truth; n=25; one run per arm, so within-model variance is unmeasured; chunking guarantees
calibration within a chunk, not across; and the set is drawn from postings production already scored
highly, so it cannot measure what production wrongly *rejected* — the more costly error.
