# Reference-ranking benchmark — RUN, 2026-08-30

Executed. Results in `ev-2026-08-30-reference-ranking-benchmark.json` and evidence record
`ev-2026-08-30-reference-ranking-benchmark`; the decision it fed is
`dec-2026-08-30-keep-sonnet5-reason-tier`.

## What was run

25 postings (the highest-scoring on the board), split into three eval cases of 9/8/8 with
descriptions truncated to 2200 characters. Four arms, one run each:

| arm | model | context |
|---|---|---|
| control | claude-opus-5 | rich — full profile, ordered role-targeting doc, lived experience, past rejections |
| production-context | claude-opus-5 | the lean production prompt |
| control | gpt-5.6-sol | rich |
| production-context | gpt-5.6-sol | lean |

Twelve calls, $1.73, ~30–49 s each. Experiments `c71ee5b1…` (Opus) and `66527391…` (sol).

## Operational notes for the next run

- **The MCP call times out at 60 s but the worker keeps going.** Two calls complete per invocation
  on Opus, one on sol. Re-invoke with the same `name` and `task` to resume; the runner derives
  what is left from `eval_runs`. Only the final invocation returns a result rather than a timeout.
- **That resume races.** A call still running inside a timed-out invocation is not yet in
  `eval_runs`, so the next invocation re-dispatches it. It happened once here (sol,
  production-context, chunk 1), cost ~$0.115, and was deduplicated by keeping the earliest row per
  (experiment, variant, case). Worth fixing with a claim row before the call rather than after.
- **gpt-5.6-sol corrupted a posting UUID** in its rich-context arm — `…f4ecc19d363f` came back as
  `…f4ecc19d6c35`. Opus did not. Any pipeline that joins model output back to postings by id needs
  to treat unmatched ids as a failure rather than silently dropping the row; that is exactly how a
  posting would vanish from a board without anything looking wrong.

## Reproducing the statistics

`node analyze.js` over the per-posting rows in the JSON. Spearman with 200,000-shuffle permutation
p-values; the reference-vs-reference comparison uses the 24 postings both arms scored.
