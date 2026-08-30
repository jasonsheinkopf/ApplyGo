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

## Retest, 2026-08-30

The Opus arm was re-run unchanged (experiment `c6ab577f…`, $0.78) to put an error bar on the
benchmark. Result: **Spearman 0.976 run-to-run, mean absolute difference 2.5 points, identical top
eight**. Recorded as `ev-2026-08-30-reference-ranking-retest`.

That noise floor is what makes the rest of the benchmark readable: 0.81 between Opus and sol is
genuine shared signal, the 17.8-point Opus/sol offset is calibration rather than variance, and the
0.17 correlation between the live board and the reference cannot be blamed on the reference moving.

**The resume race is avoidable by hand.** After a timed-out invocation, poll `eval_runs` until the
row count stops changing before re-invoking. Doing that produced zero duplicates on this run, where
firing straight back produced one. The real fix is still to claim work before the call.

## Sol retest and the rejected-pile probe, 2026-08-30

**Sol retest** (`890be630…`, $0.45): Spearman 0.922, mean absolute difference 3.4 points. Noisier
than Opus but stable, and far below the 14–18 point Opus/sol level gap, so the calibration reading
holds. Cross-model agreement across all four run pairings is 0.759–0.810; **0.785 is the fairer
summary than the originally reported 0.81**, which was the most favourable pairing.

**Rejected-pile probe** (`fdb4f61d…`, task `fit.reference_rank.rejected`, $0.79): 24 rejected
postings, half never read by anything but the screen. Highest score anywhere: **42**. Zero would
have made the board. Recorded as `ev-2026-08-30-rejected-pile-false-negatives`.

### Building a reference over a second population

`loadExperimentCases` selects by task and orders by `created_at ASC`, so new cases under an existing
task are unreachable behind the old ones. Give a second dataset its own task name in the
`fit.reference_rank.*` family — `replaySpecFor` and `taskIsItsOwnMeasurement` both match the family
by prefix (PR #130), so it inherits the expensive spec automatically.

Interleave strata within each chunk. If all the screened-out postings sat together the arm could
infer the stratum from position, and the measurement would be worth much less.
