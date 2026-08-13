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

import { type LlmEnv, type Provider, type LlmTrace, callStructured, callText } from "./llm";

export type ReplaySpec = { kind: "text" } | { kind: "structured"; schema: unknown; toolName: string; maxTokens: number };

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
      await callStructured(isolatedEnv, provider, task, prompt, spec.schema, spec.toolName, spec.maxTokens, "reason", model);
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
export async function judgeRun(
  env: LlmEnv,
  taskWhat: string,
  prompt: string,
  response: string,
  notes: string,
): Promise<{ score: number; reasoning: string }> {
  const provider: Provider = "anthropic";
  const judgePrompt = [
    "You are grading one output from an internal job-search assistant's prompt pipeline. Be exacting --",
    "this grading is used to decide whether a prompt or model change is actually an improvement.",
    "",
    `WHAT THIS TASK IS SUPPOSED TO DO:\n${taskWhat}`,
    "",
    notes.trim() ? `NOTES FROM WHOEVER SAVED THIS TEST CASE (weigh these heavily -- they know what matters here):\n${notes.trim()}` : "",
    "",
    `THE EXACT PROMPT THAT WAS SENT:\n${prompt.slice(0, 12000)}`,
    "",
    `THE RESPONSE IT PRODUCED:\n${response.slice(0, 8000) || "(empty -- the call failed or returned nothing)"}`,
  ]
    .filter(Boolean)
    .join("\n");

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
  input: { task: string; name: string; prompt: string; notes?: string; sourceTraceId?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO eval_cases (id, task, name, prompt, source_trace_id, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.task, input.name, input.prompt, input.sourceTraceId ?? null, input.notes ?? "")
    .run();
  return id;
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
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO eval_runs
       (id, case_id, provider, model, prompt, ok, response, input_tokens, output_tokens,
        cost_usd, latency_ms, error, judge_score, judge_reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    )
    .run();
  return id;
}

export async function listEvalRuns(db: Db, caseId: string): Promise<EvalRunRow[]> {
  const rows = await db
    .prepare("SELECT * FROM eval_runs WHERE case_id = ? ORDER BY created_at DESC")
    .bind(caseId)
    .all<EvalRunRow>();
  return rows.results ?? [];
}
