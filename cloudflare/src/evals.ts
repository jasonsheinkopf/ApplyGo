// The eval harness: replaying a saved prompt against an arbitrary provider/model, and scoring
// what comes back.
//
// A "case" is a prompt worth testing repeatedly -- usually promoted from a real trace, sometimes
// hand-authored. A "run" is one execution of a case against one provider/model. Cases and runs are
// the dataset PR1's tracing made possible: without a recorded prompt to replay verbatim, "compare
// models" would mean re-deriving what was actually sent, which is exactly the guesswork tracing
// exists to remove.
//
// Replay deliberately does NOT go through the router's normal trace sink, and for the same reason
// does not send to Langfuse either: an eval run is not production spend in the ordinary sense --
// it's the developer testing a hypothesis -- and letting it write into llm_traces (or a Langfuse
// project a candidate is watching) would quietly inflate both with experimentation nobody asked the
// app to do. Instead each replay installs a local, throwaway sink for the duration of one call and
// strips the Langfuse keys, captures what it recorded, and discards the sink. The judge call is the
// one exception: it runs through the real env and is traced normally under its own "evals.judge"
// task, because judging genuinely costs money and the user should see that cost like any other.

import { type Effort, type LlmEnv, type Provider, type LlmTrace, callStructured, callText, providerKeyMissing } from "./llm.ts";
import { compilePrompt, getManagedPrompt } from "./langfuse.ts";

export type ReplaySpec =
  | { kind: "text"; effort?: Effort }
  | { kind: "structured"; schema: unknown; toolName: string; maxTokens: number; effort?: Effort };

export type ReplayOutcome = {
  ok: boolean;
  response: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  error: string | null;
};

/**
 * Sends `prompt` to `model` under the given spec, using an isolated trace sink so nothing here
 * touches production accounting. `callText`/`callStructured` always record a trace -- via the sink
 * -- before rethrowing on failure, so the capture is populated on both the success and error path.
 */
export async function replayTask(
  env: LlmEnv,
  task: string,
  spec: ReplaySpec,
  provider: Provider,
  model: string,
  prompt: string,
): Promise<ReplayOutcome> {
  let captured: LlmTrace | null = null;
  const isolatedEnv: LlmEnv = {
    ...env,
    LANGFUSE_PUBLIC_KEY: undefined,
    LANGFUSE_SECRET_KEY: undefined,
    LLM_TRACE_SINK: async (trace) => {
      captured = trace;
    },
  };

  try {
    if (spec.kind === "text") {
      await callText(isolatedEnv, provider, task, prompt, model);
    } else {
      await callStructured(
        isolatedEnv, provider, task, prompt, spec.schema, spec.toolName, spec.maxTokens, "reason", model, spec.effort,
      );
    }
  } catch {
    // The isolated sink already captured the failed trace (ok:false, error set) before the throw
    // propagated here -- see llm.ts's traced(), which awaits record() before rethrowing.
  }

  if (!captured) {
    return {
      ok: false,
      response: "",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      latencyMs: 0,
      error: "no_trace_recorded",
    };
  }
  const t = captured as LlmTrace;
  return {
    ok: t.ok,
    response: t.response,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    costUsd: t.costUsd,
    latencyMs: t.latencyMs,
    error: t.error,
  };
}

// ---------------------------------------------------------------------------------------------
// Experiment statistics
//
// Everything below is pure: rows in, summary out, no env and no network. That is deliberate --
// this is the part that decides whether a prompt change ships, so it has to be testable without
// spending a cent on model calls, and reviewable without anyone having to trust a run.
// ---------------------------------------------------------------------------------------------

/** One scored run, reduced to just what a comparison needs. */
export type ScoredRun = {
  case_id: string;
  variant: string;
  ok: number;
  judge_score: number | null;
  cost_usd: number | null;
  latency_ms: number;
};

export type VariantSummary = {
  variant: string;
  /** Runs that completed AND were scored -- the denominator for every score statistic below. */
  scored: number;
  /** Runs that errored. Reported separately because a variant that fails often is worse than its scores suggest. */
  failed: number;
  mean_score: number | null;
  median_score: number | null;
  /** Population standard deviation. A mean without a spread invites reading noise as a result. */
  stdev_score: number | null;
  mean_cost_usd: number | null;
  mean_latency_ms: number | null;
};

/** Control vs. one candidate, compared only on the cases BOTH actually scored. */
export type HeadToHead = {
  variant: string;
  /** Cases where this variant beat the control. */
  wins: number;
  losses: number;
  ties: number;
  /** Cases both arms scored. Wins + losses + ties, and the honest sample size for this comparison. */
  paired: number;
  /** Mean of (candidate - control) across paired cases. The number the experiment is actually about. */
  mean_delta: number | null;
};

export type ExperimentSummary = {
  variants: VariantSummary[];
  head_to_head: HeadToHead[];
  control_variant: string;
  /** Plain-language read of the result, including when the result is "not enough evidence". */
  verdict: string;
};

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdev(values: number[]): number | null {
  const avg = mean(values);
  if (avg === null || values.length < 2) return null;
  return Math.sqrt(values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / values.length);
}

function round(value: number | null, places = 2): number | null {
  return value === null ? null : Number(value.toFixed(places));
}

/**
 * Turns an experiment's runs into the comparison a decision gets made on.
 *
 * Two choices worth naming. First, head-to-head is **paired**: a candidate is compared to the
 * control only on cases both arms actually scored, because an unpaired mean silently rewards a
 * variant that happened to fail on the hard cases -- its average goes up precisely because the
 * cases it couldn't handle dropped out. Second, the verdict refuses to call a winner on a thin or
 * noisy sample rather than reporting a difference as though it were a finding; a harness that
 * always produces a recommendation is one nobody should act on.
 */
export function summarizeExperiment(runs: ScoredRun[], controlVariant = "control"): ExperimentSummary {
  const labels = [...new Set(runs.map((r) => r.variant))].sort((a, b) =>
    a === controlVariant ? -1 : b === controlVariant ? 1 : a.localeCompare(b),
  );

  const variants: VariantSummary[] = labels.map((variant) => {
    const own = runs.filter((r) => r.variant === variant);
    const scored = own.filter((r) => r.ok === 1 && r.judge_score !== null);
    const scores = scored.map((r) => Number(r.judge_score));
    return {
      variant,
      scored: scored.length,
      failed: own.filter((r) => r.ok !== 1).length,
      mean_score: round(mean(scores)),
      median_score: round(median(scores)),
      stdev_score: round(stdev(scores)),
      mean_cost_usd: round(mean(scored.map((r) => r.cost_usd ?? 0).filter((_, i) => scored[i].cost_usd !== null)), 4),
      mean_latency_ms: round(mean(scored.map((r) => r.latency_ms)), 0),
    };
  });

  /** case_id -> score, for one variant's successfully scored runs. */
  const scoresByCase = (variant: string): Map<string, number> => {
    const out = new Map<string, number>();
    for (const run of runs) {
      if (run.variant === variant && run.ok === 1 && run.judge_score !== null) {
        out.set(run.case_id, Number(run.judge_score));
      }
    }
    return out;
  };

  const control = scoresByCase(controlVariant);
  const head_to_head: HeadToHead[] = labels
    .filter((label) => label !== controlVariant)
    .map((variant) => {
      const candidate = scoresByCase(variant);
      let wins = 0;
      let losses = 0;
      let ties = 0;
      const deltas: number[] = [];
      for (const [caseId, controlScore] of control) {
        const candidateScore = candidate.get(caseId);
        if (candidateScore === undefined) continue;
        deltas.push(candidateScore - controlScore);
        if (candidateScore > controlScore) wins += 1;
        else if (candidateScore < controlScore) losses += 1;
        else ties += 1;
      }
      return { variant, wins, losses, ties, paired: deltas.length, mean_delta: round(mean(deltas)) };
    });

  return { variants, head_to_head, control_variant: controlVariant, verdict: verdictFor(head_to_head) };
}

/** How many paired cases before a difference is worth calling a result rather than noise. */
const MIN_PAIRED = 8;

function verdictFor(comparisons: HeadToHead[]): string {
  if (!comparisons.length) return "No candidate variant to compare against the control.";

  const readings = comparisons.map((c) => {
    if (c.paired === 0) return `${c.variant}: no cases scored by both arms, so nothing can be compared.`;
    if (c.paired < MIN_PAIRED) {
      return `${c.variant}: only ${c.paired} paired case(s) — too few to call, whatever the scores say.`;
    }
    const delta = c.mean_delta ?? 0;
    const record = `${c.wins}W/${c.losses}L/${c.ties}T over ${c.paired} cases`;
    // A mean shift under 3 points on a 0-100 judge scale is inside the noise an LLM judge produces
    // re-scoring identical output, so it is reported as a wash rather than a narrow win.
    if (Math.abs(delta) < 3) return `${c.variant}: no meaningful difference (${delta >= 0 ? "+" : ""}${delta}, ${record}).`;
    if (delta > 0) return `${c.variant}: better by ${delta} points on average (${record}).`;
    return `${c.variant}: worse by ${Math.abs(delta)} points on average (${record}).`;
  });

  return readings.join(" ");
}

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    score: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description:
        "0-100. How well the response fulfills the task's stated purpose: correct, complete, follows the " +
        "requested shape, and grounded in the prompt's own content rather than inventing anything. 100 is " +
        "exactly what a careful human would produce; 0 is unusable or wrong.",
    },
    reasoning: {
      type: "string",
      description: "One or two sentences, specific to this response -- what it got right or wrong, not a generic rubric restatement.",
    },
  },
  required: ["score", "reasoning"],
} as const;

/**
 * Scores one eval run against what the task is supposed to accomplish. Runs through the real env
 * (not an isolated one) so this call is traced and costed like any other -- judging is real spend,
 * and hiding it from the Cost tab would defeat the point of tracing in the first place.
 *
 * `notes` is the eval case's own free-text field, appended verbatim so a case author can steer the
 * judge toward what actually matters for that specific prompt (a rubric, a known edge case, a
 * reference answer) without the harness needing per-task rubric authoring.
 */
/**
 * Which provider scores a run.
 *
 * Anthropic is the default and stays the default: every experiment should be judged on one scale,
 * and silently rotating judges between runs would make two arms incomparable for a reason that has
 * nothing to do with either prompt. But a hardcoded provider means one vendor's outage or spend cap
 * takes the whole harness down -- which is not hypothetical: the cap was reached mid-session and
 * every judge call would have failed with the evaluation itself perfectly healthy.
 *
 * So the fallback is deliberately narrow. It fires only when the preferred judge has no usable key
 * at all, never to spread load or save money, and callers can see which provider ran from the run
 * record. A judged-by-the-other-model experiment is worth flagging; a wholly unjudged one is worth
 * nothing.
 */
export function judgeProvider(env: LlmEnv): Provider {
  const preferred: Provider = "anthropic";
  if (!providerKeyMissing(env, preferred)) return preferred;
  const alternate: Provider = "openai";
  return providerKeyMissing(env, alternate) ? preferred : alternate;
}

export async function judgeRun(
  env: LlmEnv,
  taskWhat: string,
  prompt: string,
  response: string,
  notes: string,
): Promise<{ score: number; reasoning: string }> {
  const provider = judgeProvider(env);
  const judgePrompt = await getManagedPrompt(env, "evaluation/judge", {
    task_description: taskWhat,
    case_notes: notes.trim()
      ? `NOTES FROM WHOEVER SAVED THIS TEST CASE (weigh these heavily -- they know what matters here):\n${notes.trim()}`
      : "",
    evaluated_prompt: prompt.slice(0, 12000),
    evaluated_response: response.slice(0, 8000) || "(empty -- the call failed or returned nothing)",
  });

  const result = await callStructured<{ score: number; reasoning: string }>(
    env,
    provider,
    "evals.judge",
    judgePrompt,
    JUDGE_SCHEMA,
    "submit_judgment",
    600,
  );
  return {
    score: Math.max(0, Math.min(100, Math.round(Number(result.score) || 0))),
    reasoning: String(result.reasoning ?? "").trim(),
  };
}

// ---------------------------------------------------------------------------------------------
// D1 access. Same shape as devconsole.ts's read functions: plain `db` in, plain data out, so the
// route handler in index.ts stays the only place that knows about HTTP.
// ---------------------------------------------------------------------------------------------

type Db = D1Database;

export type EvalCaseRow = {
  id: string;
  task: string;
  name: string;
  prompt: string;
  source_trace_id: string | null;
  notes: string;
  /** The inputs that produced `prompt`, so a different template can be rendered over the same data. */
  variables_json: string;
  /** Which managed prompt those variables were compiled against, for provenance. */
  prompt_name: string;
  created_at: string;
  updated_at: string;
};

export type EvalRunRow = {
  id: string;
  case_id: string;
  provider: string;
  model: string;
  prompt: string;
  ok: number;
  response: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  latency_ms: number;
  error: string | null;
  judge_score: number | null;
  judge_reasoning: string | null;
  created_at: string;
};

export async function createEvalCase(
  db: Db,
  input: {
    task: string;
    name: string;
    prompt: string;
    notes?: string;
    sourceTraceId?: string | null;
    /**
     * The inputs the prompt was compiled from. Without these a case can only ever be replayed as
     * the exact string it was saved as, which is enough to compare two *models* and useless for
     * comparing two *wordings* -- runExperiment needs to render a different template over the same
     * data. Migration 0037 added the column and runExperiment reads it, but nothing ever wrote it,
     * so every case reached an experiment with `{}` and no variant could be rendered. An
     * experiment over such cases doesn't fail loudly; it just has nothing to compare.
     */
    variables?: Record<string, string>;
    /** Which managed prompt those variables were compiled against, for provenance. */
    promptName?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO eval_cases (id, task, name, prompt, source_trace_id, notes, variables_json, prompt_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.task,
      input.name,
      input.prompt,
      input.sourceTraceId ?? null,
      input.notes ?? "",
      JSON.stringify(input.variables ?? {}),
      input.promptName ?? "",
    )
    .run();
  return id;
}

/**
 * True when a case carries enough to be rendered through an alternative prompt template.
 *
 * A case saved before variables were recorded still replays fine against different models -- its
 * saved prompt string is intact -- but it cannot take part in a prompt A/B test, because there is
 * nothing to compile the candidate wording over. Experiments filter on this rather than running
 * the case and reporting a template error, so a mixed dataset shrinks the sample honestly instead
 * of filling the record with failures that say nothing about the variant.
 */
export function caseIsExperimentReady(row: { variables_json?: string | null }): boolean {
  try {
    const parsed = JSON.parse(row.variables_json || "{}") as Record<string, unknown>;
    return !!parsed && typeof parsed === "object" && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

/** Cases grouped by task, each carrying its run count and best score for quick scanning. */
export async function listEvalCases(db: Db, task?: string): Promise<unknown[]> {
  const clause = task ? "WHERE c.task = ?" : "";
  const rows = await db
    .prepare(
      `SELECT c.id, c.task, c.name, c.notes, c.source_trace_id, c.created_at, c.updated_at,
              COUNT(r.id) AS run_count,
              MAX(r.judge_score) AS best_score,
              MAX(r.created_at) AS last_run_at
       FROM eval_cases c
       LEFT JOIN eval_runs r ON r.case_id = c.id
       ${clause}
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
    )
    .bind(...(task ? [task] : []))
    .all();
  return rows.results ?? [];
}

export async function getEvalCase(db: Db, id: string): Promise<EvalCaseRow | null> {
  return await db.prepare("SELECT * FROM eval_cases WHERE id = ?").bind(id).first<EvalCaseRow>();
}

export async function updateEvalCase(
  db: Db,
  id: string,
  patch: { prompt?: string; name?: string; notes?: string },
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.prompt !== undefined) {
    sets.push("prompt = ?");
    binds.push(patch.prompt);
  }
  if (patch.name !== undefined) {
    sets.push("name = ?");
    binds.push(patch.name);
  }
  if (patch.notes !== undefined) {
    sets.push("notes = ?");
    binds.push(patch.notes);
  }
  if (!sets.length) return;
  sets.push("updated_at = CURRENT_TIMESTAMP");
  await db
    .prepare(`UPDATE eval_cases SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds, id)
    .run();
}

export async function createEvalRun(
  db: Db,
  input: {
    caseId: string;
    provider: string;
    model: string;
    prompt: string;
    outcome: ReplayOutcome;
    judgeScore: number | null;
    judgeReasoning: string | null;
    /** Set only when this run is one arm of a comparison; a plain replay leaves both unset. */
    experimentId?: string | null;
    variant?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO eval_runs
       (id, case_id, provider, model, prompt, ok, response, input_tokens, output_tokens,
        cost_usd, latency_ms, error, judge_score, judge_reasoning, experiment_id, variant)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.caseId,
      input.provider,
      input.model,
      input.prompt,
      input.outcome.ok ? 1 : 0,
      input.outcome.response,
      input.outcome.inputTokens,
      input.outcome.outputTokens,
      input.outcome.costUsd,
      input.outcome.latencyMs,
      input.outcome.error,
      input.judgeScore,
      input.judgeReasoning,
      input.experimentId ?? null,
      input.variant ?? "",
    )
    .run();
  return id;
}

// ---------------------------------------------------------------------------------------------
// Experiments: running one, and reading it back
// ---------------------------------------------------------------------------------------------

/** One arm of an experiment: a label plus the prompt template that arm sends. */
/**
 * One arm of an experiment.
 *
 * `provider` and `model` are optional and default to the experiment's own. Supplying them is what
 * turns this harness into a model bake-off: hold `template` identical across every arm and vary
 * only the model, and the existing paired statistics answer "which model is better on this task"
 * using the same machinery that answers "which wording is better" -- same judge, same cases, same
 * refusal to call a winner on too few pairs. VariantSummary already carries mean cost and mean
 * latency per arm, so quality, price and speed come out of one run rather than three.
 */
export type Variant = { label: string; template: string; provider?: Provider; model?: string };

export type ExperimentRow = {
  id: string;
  name: string;
  task: string;
  hypothesis: string;
  status: string;
  control_variant: string;
  created_at: string;
  completed_at: string | null;
};

export async function createExperiment(
  db: Db,
  input: { name: string; task: string; hypothesis?: string; controlVariant?: string },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO eval_experiments (id, name, task, hypothesis, control_variant) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, input.name, input.task, input.hypothesis ?? "", input.controlVariant ?? "control")
    .run();
  return id;
}

export async function getExperiment(db: Db, id: string): Promise<ExperimentRow | null> {
  return await db.prepare("SELECT * FROM eval_experiments WHERE id = ?").bind(id).first<ExperimentRow>();
}

export async function listExperiments(db: Db, limit = 25): Promise<unknown[]> {
  const rows = await db
    .prepare(
      `SELECT e.*, COUNT(r.id) AS run_count
       FROM eval_experiments e LEFT JOIN eval_runs r ON r.experiment_id = e.id
       GROUP BY e.id ORDER BY e.created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all();
  return rows.results ?? [];
}

/** The runs belonging to one experiment, in the shape summarizeExperiment consumes. */
export async function loadExperimentRuns(db: Db, experimentId: string): Promise<ScoredRun[]> {
  const rows = await db
    .prepare(
      `SELECT case_id, variant, ok, judge_score, cost_usd, latency_ms
       FROM eval_runs WHERE experiment_id = ?`,
    )
    .bind(experimentId)
    .all<ScoredRun>();
  return rows.results ?? [];
}

/** Cases usable as experiment fixtures: those whose inputs were recorded, not just their output. */
export async function loadExperimentCases(db: Db, task: string, limit: number): Promise<EvalCaseRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM eval_cases
       WHERE task = ? AND variables_json != '{}' AND variables_json != ''
       ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(task, limit)
    .all<EvalCaseRow>();
  return rows.results ?? [];
}

/**
 * Runs every variant against every case, scores each result, and records it under the experiment.
 *
 * The loop is deliberately case-outer/variant-inner so that both arms see the same case close
 * together in time. A model provider's latency and, occasionally, its behaviour drift over a long
 * run; interleaving means such drift lands on both arms roughly equally instead of systematically
 * penalising whichever variant happened to run second.
 *
 * Every arm is scored by the same judge with the same rubric -- the case's own notes. That is the
 * only way the scores are comparable at all: a judge given different instructions per arm is
 * measuring two different things and calling the difference a result.
 *
 * Failures are recorded rather than thrown. A variant that errors on a case is a real finding
 * about that variant, and summarizeExperiment counts it separately from a low score.
 */
/**
 * One unit of experiment work: a single case rendered through a single variant.
 *
 * The unit is deliberately one model call rather than one case or one experiment. That is what
 * makes an experiment resumable, and resumability is what this harness was missing: it dispatched
 * the whole thing to `ctx.waitUntil` and returned 202, which works while every call is a cheap
 * classification and silently loses everything once a call takes minutes. Three reference-ranking
 * experiments across two providers recorded zero runs that way -- not failed runs, no rows at all,
 * because the background work was reclaimed before any call returned. Evidence:
 * ev-2026-08-30-experiment-runner-drops-long-calls.
 */
export type PendingWork = { evalCase: EvalCaseRow; variant: Variant };

/**
 * The (case, variant) pairs an experiment still owes, derived from what is already recorded rather
 * than from a cursor.
 *
 * Deriving it means a caller can stop and resume at any point, a crashed run leaves no phantom
 * progress, and re-invoking is idempotent: work already in `eval_runs` is simply not pending any
 * more. A stored position would have to be kept in step with the rows and would drift the first
 * time a run failed halfway.
 */
export function pendingWork(cases: EvalCaseRow[], variants: Variant[], done: { case_id: string; variant: string }[]): PendingWork[] {
  const finished = new Set(done.map((row) => `${row.case_id}\u0000${row.variant}`));
  const out: PendingWork[] = [];
  for (const evalCase of cases.filter(caseIsExperimentReady)) {
    for (const variant of variants) {
      if (finished.has(`${evalCase.id}\u0000${variant.label}`)) continue;
      out.push({ evalCase, variant });
    }
  }
  return out;
}

/** Runs already recorded for an experiment, as the (case, variant) pairs they cover. */
export async function recordedPairs(db: Db, experimentId: string): Promise<{ case_id: string; variant: string }[]> {
  const rows = await db
    .prepare("SELECT case_id, variant FROM eval_runs WHERE experiment_id = ?")
    .bind(experimentId)
    .all<{ case_id: string; variant: string }>();
  return rows.results ?? [];
}

/**
 * Whether a task's output is the measurement itself, rather than something a judge should score.
 *
 * A reference ranking exists to produce scores that other models are compared against. Asking a
 * judge to grade it inverts the relationship, doubles the call count, and doubles the time a
 * bounded run has to fit inside -- so the judge is skipped and the arm's own scores are the result.
 */
export function taskIsItsOwnMeasurement(task: string): boolean {
  return task.startsWith("fit.reference_rank");
}

/**
 * Advances an experiment by at most `maxCalls` model calls, synchronously, and reports what is
 * left.
 *
 * Bounded and synchronous on purpose. The previous design handed the whole experiment to
 * `ctx.waitUntil` and returned immediately, which is fine while every call is a cheap
 * classification and fails silently once a call takes minutes -- the isolate is reclaimed, no row
 * is written, and the experiment sits at `running` for ever with nothing to show and no error to
 * read. Doing the work inside the request instead means each call is awaited by something that
 * will still be alive when it returns, and the caller decides how much to do per invocation. It is
 * the same shape the job pipeline already uses successfully for its own batched work.
 *
 * Resumption is derived from `eval_runs` rather than stored, so calling this repeatedly is
 * idempotent and a failure halfway through loses only the call it was making.
 */
export async function advanceExperiment(
  env: LlmEnv,
  db: Db,
  input: {
    experimentId: string;
    task: string;
    taskDescription: string;
    spec: ReplaySpec;
    provider: Provider;
    model: string;
    variants: Variant[];
    cases: EvalCaseRow[];
    maxCalls: number;
  },
): Promise<{ completed: number; remaining: number; errors: string[] }> {
  const done = await recordedPairs(db, input.experimentId);
  const pending = pendingWork(input.cases, input.variants, done);
  const budget = Math.max(1, Math.floor(input.maxCalls));
  const errors: string[] = [];
  let completed = 0;

  for (const { evalCase, variant } of pending.slice(0, budget)) {
    let variables: Record<string, string> = {};
    try {
      variables = JSON.parse(evalCase.variables_json || "{}") as Record<string, string>;
    } catch {
      continue; // A case whose inputs won't parse can't be rendered through any variant.
    }

    const provider = variant.provider ?? input.provider;
    const model = variant.model ?? input.model;

    let prompt: string;
    try {
      prompt = compilePrompt(variant.template, variables);
    } catch (error) {
      // A template that doesn't accept this case's variables is a real defect in the variant, and
      // recording it as a failed run says so instead of quietly shrinking the sample.
      await createEvalRun(db, {
        caseId: evalCase.id, provider, model, prompt: variant.template,
        outcome: {
          ok: false, response: "", inputTokens: 0, outputTokens: 0,
          costUsd: null, latencyMs: 0, error: `template_error: ${(error as Error).message}`,
        },
        judgeScore: null, judgeReasoning: null,
        experimentId: input.experimentId, variant: variant.label,
      });
      completed += 1;
      errors.push(`${variant.label}: template_error`);
      continue;
    }

    const outcome = await replayTask(env, input.task, input.spec, provider, model, prompt);
    let judgeScore: number | null = null;
    let judgeReasoning: string | null = null;
    // A reference ranking is the measurement, not a candidate for one -- judging it would invert
    // the relationship and double both the cost and the time this bounded run has to fit inside.
    if (outcome.ok && !taskIsItsOwnMeasurement(input.task)) {
      try {
        const judged = await judgeRun(env, input.taskDescription, prompt, outcome.response, evalCase.notes);
        judgeScore = judged.score;
        judgeReasoning = judged.reasoning;
      } catch (error) {
        judgeReasoning = `judge_failed: ${(error as Error).message}`;
      }
    }
    await createEvalRun(db, {
      caseId: evalCase.id, provider, model, prompt, outcome,
      judgeScore, judgeReasoning,
      experimentId: input.experimentId, variant: variant.label,
    });
    completed += 1;
    if (!outcome.ok && outcome.error) errors.push(`${variant.label}: ${outcome.error.slice(0, 160)}`);
  }

  const remaining = Math.max(0, pending.length - completed);
  await db
    .prepare(
      remaining === 0
        ? "UPDATE eval_experiments SET status = 'complete', completed_at = CURRENT_TIMESTAMP WHERE id = ?"
        : "UPDATE eval_experiments SET status = 'running' WHERE id = ?",
    )
    .bind(input.experimentId)
    .run();
  return { completed, remaining, errors };
}


export async function listEvalRuns(db: Db, caseId: string): Promise<EvalRunRow[]> {
  const rows = await db
    .prepare("SELECT * FROM eval_runs WHERE case_id = ? ORDER BY created_at DESC")
    .bind(caseId)
    .all<EvalRunRow>();
  return rows.results ?? [];
}

// ---------------------------------------------------------------------------
// Building a screen case set out of postings whose outcome is already known
// ---------------------------------------------------------------------------

/**
 * One posting with the verdict the cheap screen *should* have reached on it, and why.
 *
 * The labels come from what actually happened downstream rather than from anyone's opinion:
 * `keep` is a posting the full assessment later rated worth surfacing, so dropping it on the title
 * would have lost a real opportunity permanently; `drop` is a posting whose title names a different
 * profession entirely, which is the only thing this tier is asked to catch.
 */
export type LabelledPosting = {
  id: string;
  title: string;
  location: string;
  label: "keep" | "drop";
  why: string;
};

/**
 * Splits labelled postings into batches that each contain both labels.
 *
 * This is the part that decides whether the eval measures anything. The screen returns a keep/drop
 * per posting, so a batch of only must-keeps is aced by a variant that keeps everything, and a
 * batch of only must-drops is aced by one that drops everything -- in both cases the judge sees a
 * perfect score for a prompt that isn't discriminating at all. Interleaving the two labels means a
 * variant has to actually separate them to score well.
 *
 * A batch that cannot be given both labels is not emitted. Returning a degenerate batch would be
 * worse than returning fewer: the experiment would report a confident result built partly on cases
 * that could not distinguish the arms.
 */
export function screenCaseBatches(postings: LabelledPosting[], batchSize: number): LabelledPosting[][] {
  const size = Math.max(2, Math.floor(batchSize));
  const keeps = postings.filter((p) => p.label === "keep");
  const drops = postings.filter((p) => p.label === "drop");
  if (!keeps.length || !drops.length) return [];

  // Capped by the scarcer label, because every batch is owed one of each -- and by how many
  // batches the postings can actually fill, so a large pool of both labels doesn't produce a long
  // tail of two-item batches.
  const count = Math.min(keeps.length, drops.length, Math.max(1, Math.ceil(postings.length / size)));
  const batches: LabelledPosting[][] = Array.from({ length: count }, () => []);

  // Seed both labels first. Doing this before any filling is what makes the guarantee structural
  // rather than something the distribution happens to satisfy.
  for (const batch of batches) {
    batch.push(keeps.shift() as LabelledPosting, drops.shift() as LabelledPosting);
  }

  // Then fill the remainder, taking the first batch still under size. Later batches may end up
  // smaller than the first, which is fine: the size cap is a ceiling for prompt cost, not a shape
  // every batch has to hit.
  for (const posting of [...keeps, ...drops]) {
    const target = batches.find((batch) => batch.length < size);
    if (!target) break;
    target.push(posting);
  }
  return batches;
}

/**
 * The gold labels for one batch, written for the judge rather than for a diff.
 *
 * `judgeRun` passes a case's notes to the judge and tells it to weigh them heavily, which is the
 * only place in this harness where a known-correct answer can be stated. Spelling the expected
 * verdict out per id turns a vague "is this a good screening decision" into a checkable one, and
 * naming the asymmetry keeps the judge from rewarding an aggressive variant: a wrong drop loses a
 * real posting for good, while a wrong keep costs one more cheap read.
 */
export function screenCaseNotes(batch: LabelledPosting[]): string {
  const keeps = batch.filter((p) => p.label === "keep");
  const drops = batch.filter((p) => p.label === "drop");
  const lines = [
    "GRADING KEY -- these verdicts are known from what happened to each posting after this stage.",
    "",
    "MUST KEEP (a full assessment later rated each of these worth surfacing to the candidate; a",
    "drop here would have lost a real opportunity permanently and is the most serious error):",
    ...keeps.map((p) => `- ${p.id} -- "${p.title}" (${p.why})`),
    "",
    "SHOULD DROP (a different profession; keeping one is only a wasted read, not a lost chance):",
    ...drops.map((p) => `- ${p.id} -- "${p.title}" (${p.why})`),
    "",
    "Score recall on MUST KEEP far more heavily than precision on SHOULD DROP. A response that",
    "keeps everything is not a good response -- it passes every must-keep while doing none of the",
    "filtering this stage exists for -- but missing a must-keep is worse than keeping a should-drop.",
  ];
  return lines.join("\n");
}
