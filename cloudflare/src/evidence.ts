/**
 * The evidence layer: measurements, the decisions they caused, and the trail between them.
 *
 * The eval harness answers "which variant won" while an experiment is in front of you. This module
 * answers the questions that only appear later -- why is the pipeline configured this way, what did
 * we try that failed, can this chart be rebuilt, what changed our minds -- by keeping the numbers
 * in structured form rather than letting a prose summary become the only surviving record.
 *
 * The rule this module exists to enforce: a report is derivative. If a graph or a claim cannot be
 * regenerated from a stored record, the record is incomplete.
 */

import { type LlmEnv, type Provider, callStructured, providerKeyMissing } from "./llm.ts";
import { getManagedPrompt } from "./langfuse.ts";

type Db = D1Database;

export type EvidenceKind =
  | "model_comparison"
  | "prompt_experiment"
  | "coverage_expansion"
  | "defect_measurement"
  | "cost_measurement"
  | "calibration";

export type CareerEvidence = {
  type: string;
  strength: "low" | "medium" | "high" | "exceptional";
  summary: string;
  metric?: string;
  context?: string;
  action?: string;
  result?: string;
  why_interesting?: string;
};

export type EvidenceInput = {
  slug: string;
  kind: EvidenceKind | string;
  question: string;
  method?: string;
  sampleSize?: number;
  sampleDescription?: string;
  /** Aggregates a report quotes, plus per-item rows wherever the per-item detail is the point. */
  metrics?: unknown;
  examples?: unknown;
  conclusion?: string;
  confidence?: "low" | "medium" | "high";
  limitations?: string;
  provenance?: unknown;
  career?: CareerEvidence | null;
};

/**
 * Writes one measurement. Upserts on slug so re-running a measurement corrects it in place rather
 * than leaving two rows a later reader has to choose between -- but see `supersedeEvidence` for
 * the case where the *finding* changed, which must not overwrite what was believed before.
 */
export async function recordEvidence(db: Db, input: EvidenceInput): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO evidence_records
         (id, slug, kind, question, method, sample_size, sample_description, metrics_json,
          examples_json, conclusion, confidence, limitations, provenance_json,
          career_evidence_candidate, career_evidence_type, career_evidence_strength, career_evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         kind = excluded.kind, question = excluded.question, method = excluded.method,
         sample_size = excluded.sample_size, sample_description = excluded.sample_description,
         metrics_json = excluded.metrics_json, examples_json = excluded.examples_json,
         conclusion = excluded.conclusion, confidence = excluded.confidence,
         limitations = excluded.limitations, provenance_json = excluded.provenance_json,
         career_evidence_candidate = excluded.career_evidence_candidate,
         career_evidence_type = excluded.career_evidence_type,
         career_evidence_strength = excluded.career_evidence_strength,
         career_evidence_json = excluded.career_evidence_json,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      id, input.slug, input.kind, input.question, input.method ?? "",
      input.sampleSize ?? 0, input.sampleDescription ?? "",
      JSON.stringify(input.metrics ?? {}), JSON.stringify(input.examples ?? []),
      input.conclusion ?? "", input.confidence ?? "low", input.limitations ?? "",
      JSON.stringify(input.provenance ?? {}),
      input.career ? 1 : 0, input.career?.type ?? "", input.career?.strength ?? "",
      JSON.stringify(input.career ?? {}),
    )
    .run();
  return input.slug;
}

/**
 * Marks an earlier measurement as overturned by a later one, without editing it.
 *
 * The superseded row keeps its original numbers and conclusion. Rewriting it to match the new
 * finding would erase the fact that the system once believed something else, which is precisely
 * the history that makes a repair log worth reading.
 */
export async function supersedeEvidence(db: Db, oldSlug: string, newSlug: string): Promise<void> {
  await db
    .prepare("UPDATE evidence_records SET superseded_by = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?")
    .bind(newSlug, oldSlug)
    .run();
}

export type DecisionInput = {
  slug: string;
  summary: string;
  area?: string;
  rationale?: string;
  evidenceSlugs?: string[];
  alternatives?: string;
  expectedBenefit?: string;
  decidedBy?: "human" | "agent" | "agent_with_human_approval";
  provenance?: unknown;
};

/** Writes one decision, pointing at the evidence that caused it. */
export async function recordDecision(db: Db, input: DecisionInput): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO decision_records
         (id, slug, summary, area, rationale, evidence_slugs_json, alternatives, expected_benefit,
          decided_by, provenance_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         summary = excluded.summary, area = excluded.area, rationale = excluded.rationale,
         evidence_slugs_json = excluded.evidence_slugs_json, alternatives = excluded.alternatives,
         expected_benefit = excluded.expected_benefit, decided_by = excluded.decided_by,
         provenance_json = excluded.provenance_json, updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      id, input.slug, input.summary, input.area ?? "", input.rationale ?? "",
      JSON.stringify(input.evidenceSlugs ?? []), input.alternatives ?? "",
      input.expectedBenefit ?? "", input.decidedBy ?? "agent",
      JSON.stringify(input.provenance ?? {}),
    )
    .run();
  return input.slug;
}

/**
 * Records what a decision actually did, once it has run long enough to have an effect.
 *
 * Kept separate from `expected_benefit` so the prediction and the outcome can disagree on the
 * record. A forecast quietly edited to match what happened teaches nothing.
 */
export async function recordObservedResult(db: Db, slug: string, observed: string): Promise<void> {
  await db
    .prepare("UPDATE decision_records SET observed_result = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?")
    .bind(observed, slug)
    .run();
}

// ---------------------------------------------------------------------------
// Adjudication -- used where deterministic metrics genuinely cannot decide
// ---------------------------------------------------------------------------

/**
 * Which cases are worth paying a judge to look at.
 *
 * A judge is an adjudication mechanism, not a metric. Running one across every result costs real
 * money to re-confirm what the numbers already say, so the selection rule is: spend it where the
 * deterministic evidence is genuinely unable to decide.
 *
 * Two arms scoring a case 78 and 76 do not need adjudicating -- that gap is inside judge noise and
 * either answer is defensible. Two arms scoring 80 and 18 need it badly: one of them is wrong in a
 * way that changes what the candidate is shown. Sorting by disagreement and taking the top slice
 * puts the budget on the cases that can still change a decision.
 */
export type Disagreement<T> = { case_id: string; a: number; b: number; gap: number; item: T };

export function selectDisagreements<T>(
  items: T[],
  read: (item: T) => { case_id: string; a: number | null; b: number | null },
  options: { minGap?: number; limit?: number } = {},
): Disagreement<T>[] {
  const minGap = options.minGap ?? 20;
  const limit = Math.max(1, options.limit ?? 8);
  const out: Disagreement<T>[] = [];
  for (const item of items) {
    const { case_id, a, b } = read(item);
    // A case only one arm scored is not a disagreement, it is missing data -- and adjudicating it
    // would quietly turn a failed run into a quality signal about the arm that did respond.
    if (a === null || b === null) continue;
    const gap = Math.abs(a - b);
    if (gap < minGap) continue;
    out.push({ case_id, a, b, gap, item });
  }
  return out.sort((x, y) => y.gap - x.gap).slice(0, limit);
}

export const ADJUDICATION_SCHEMA = {
  type: "object",
  properties: {
    winner: {
      type: "string",
      enum: ["A", "B", "tie", "insufficient_evidence"],
      description: "Which assessment is more useful. 'insufficient_evidence' when the material given cannot settle it.",
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    dimensions: {
      type: "array",
      description: "One entry per rubric dimension, scored independently BEFORE the overall preference.",
      items: {
        type: "object",
        properties: {
          dimension: { type: "string" },
          better: { type: "string", enum: ["A", "B", "tie"] },
          note: { type: "string", description: "One sentence. What specifically was better, not that it was better." },
        },
        required: ["dimension", "better", "note"],
      },
    },
    decisive_evidence: { type: "string", description: "The single fact that settled it, quoted from the material." },
    weakness_a: { type: "string" },
    weakness_b: { type: "string" },
    reasoning: { type: "string" },
  },
  required: ["winner", "confidence", "dimensions", "decisive_evidence", "reasoning"],
} as const;

export type Adjudication = {
  winner: "A" | "B" | "tie" | "insufficient_evidence";
  confidence: "low" | "medium" | "high";
  dimensions: { dimension: string; better: "A" | "B" | "tie"; note: string }[];
  decisive_evidence: string;
  weakness_a?: string;
  weakness_b?: string;
  reasoning: string;
};

/**
 * The default rubric for "which of these two job assessments is more useful to the candidate".
 *
 * Stated as dimensions rather than a single preference, because an unconstrained "which is better"
 * reliably rewards the longer answer. Each is scored independently before the overall call, so a
 * win on presentation cannot quietly carry a loss on correctness.
 */
export const FIT_ASSESSMENT_RUBRIC = [
  "Rule compliance -- does the score respect the candidate's stated hard constraints (experience tier, geography, compensation, title rules)? A score that ignores a stated dealbreaker is wrong however well argued.",
  "Correct read of the role -- does the assessment describe what the job actually is (hands-on build, pre-sales, people management, research), rather than pattern-matching its title?",
  "Evidence quality -- are the stated gaps real, specific and drawn from the posting, rather than generic or absent?",
  "Calibration -- is the number defensible given the stated gaps? A high score alongside serious unmet requirements is a contradiction.",
  "Actionability -- would this help the candidate decide whether to spend an evening applying?",
] as const;

/**
 * Adjudicates two assessments of the same posting.
 *
 * Blind by construction: the caller decides which arm is presented as A, and the judge is told
 * only that these are two assessments -- never which is the incumbent, which model produced
 * either, or which one is expected to win. Presentation order is returned so the caller can store
 * it and later check whether position predicted the verdict, rather than assuming it did not.
 */
export async function adjudicate(
  env: LlmEnv,
  input: {
    question: string;
    context: string;
    rubric: readonly string[];
    assessmentA: string;
    assessmentB: string;
    provider?: Provider;
    model?: string;
  },
): Promise<{ result: Adjudication; provider: Provider; model: string }> {
  const provider = pickJudgeProvider(env, input.provider);
  const prompt = await getManagedPrompt(
    env,
    "evaluation/adjudicate",
    {
      question: input.question,
      context: input.context,
      rubric: input.rubric.map((line, i) => `${i + 1}. ${line}`).join("\n"),
      assessment_a: input.assessmentA,
      assessment_b: input.assessmentB,
    },
    ADJUDICATE_PROMPT,
  );
  const result = await callStructured<Adjudication>(
    env,
    provider,
    "evals.adjudicate",
    prompt,
    ADJUDICATION_SCHEMA,
    "submit_adjudication",
    1600,
  );
  return { result, provider, model: input.model ?? "" };
}

/**
 * The judge's provider, resolved rather than hardcoded.
 *
 * Which model judges is a configuration choice, not an architectural assumption: an experiment
 * record stores the judge that produced it, so a later run can substitute a different judge and
 * still be compared against the original. Falls back only when the requested provider has no key,
 * because an unjudged comparison is worth nothing and a comparison judged by the other vendor is
 * at least worth labelling.
 */
export function pickJudgeProvider(env: LlmEnv, requested?: Provider): Provider {
  const preferred: Provider = requested ?? "anthropic";
  if (!providerKeyMissing(env, preferred)) return preferred;
  const alternate: Provider = preferred === "anthropic" ? "openai" : "anthropic";
  return providerKeyMissing(env, alternate) ? preferred : alternate;
}

/** Bundled default, so adjudication works before the prompt is published to Langfuse. */
export const ADJUDICATE_PROMPT = {
  requires: ["assessment_a", "assessment_b", "rubric"],
  schemaVersion: 1,
  text: `You are adjudicating between two independent assessments of the SAME job posting for the
same candidate. They disagree, and a person has to act on one of them.

You are NOT told which assessment came from which system, which is the incumbent, or which is
expected to win. Do not speculate about their origins -- judge only what is in front of you.

THE QUESTION
{{question}}

CONTEXT -- the candidate's situation and constraints, and the posting being assessed:
{{context}}

RUBRIC -- score each dimension independently and say which assessment is better on it, BEFORE
forming any overall preference. Do not let a win on one dimension carry the others:
{{rubric}}

ASSESSMENT A
{{assessment_a}}

ASSESSMENT B
{{assessment_b}}

RULES
- Length, confidence of tone, and polish are NOT quality. A shorter assessment that respects the
  candidate's stated constraints beats a longer one that ignores them.
- A score is only as good as the gaps stated beside it. A high score with serious unmet
  requirements listed, or with no gaps listed on a demanding posting, is a contradiction -- say so.
- If the material genuinely cannot settle it, return "insufficient_evidence". That is a real and
  useful answer; a coin-flip dressed as a judgment is not.
- decisive_evidence must quote or closely paraphrase something actually present in the material.

Return only the structured output.`,
};
