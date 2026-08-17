/**
 * Strengthen Profile: using a real job the candidate wants as the prompt for remembering evidence
 * the canonical profile does not yet hold.
 *
 * The product idea in one line: a generic "what's missing from your profile?" audit asks weak
 * questions because it has no reason to prefer one gap over another, but a specific posting does.
 * It says which requirements matter, and comparing them against the record says exactly where the
 * record is thin. That turns an open-ended interview into a short list of targeted, answerable
 * questions -- and because the answers land in the canonical profile rather than in a per-job
 * scratchpad, doing this for job #2 starts from everything job #1 uncovered. The question count is
 * supposed to fall over time. That is the feature working, not the feature running out of ideas.
 *
 * WHY THIS IS NOT A NEW PIPELINE
 * Stages A-C already existed, inside the resume builder: `extractJobRequirements` reads a posting
 * into discrete requirements, `planEvidence` matches them against the profile and grades coverage
 * proven/partial/unproven, and `normalizePlan` verifies in code that cited evidence actually traces
 * back to the record. That work was simply thrown away after each resume build and recomputed on
 * the next one. So this module does not re-derive any of it; it persists it as a durable per-job
 * artifact (`job_evidence_analysis`), adds the one genuinely new stage on top -- turning graded
 * gaps into targeted questions -- and lets the resume and cover-letter writers read the saved
 * artifact instead of paying for the same two model calls again.
 *
 * WHY NOT LANGGRAPH
 * The brief proposed modeling this as a LangGraph workflow. This app is a TypeScript Cloudflare
 * Worker with no Python runtime, no LangChain dependency, and an explicit standing decision not to
 * have adopted a durable workflow engine yet (docs/decisions/index.md ADR-010,
 * docs/workflow/agent-workflow.md: "There is no LangGraph or durable workflow-run object"). Adding
 * one here would mean a second runtime beside the Worker for one feature -- the "parallel system"
 * outcome the brief itself rules out. What LangGraph was wanted *for* is what this module actually
 * provides: named stages that run in a fixed order, structured state that persists between them,
 * a human interrupt in the middle (the candidate answering), and per-stage traces. The stages are
 * plain exported functions, D1 is the checkpoint store, the interrupt is the page itself, and each
 * stage carries its own LlmTaskId so Langfuse groups it separately.
 *
 * Stage map (the ids are the ones the tracing layer sees):
 *   A analyze_job_requirements   -> philosophy.extractJobRequirements   [resume.requirements]
 *   B retrieve_candidate_evidence \ philosophy.planEvidence             [resume.plan_evidence]
 *   C assess_requirement_coverage /   (+ code-side fabrication check)
 *   D generate_clarification_questions -> this module                   [strengthen.questions]
 *   -- interrupt: the candidate answers on the page --
 *   E extract_profile_updates \  index.applyProfileAnswers              [profile.improve_apply]
 *   F merge_profile_updates    /   (reused verbatim from the Improve workflow)
 *   G reassess_coverage        -> re-runs B/C against the enriched profile
 *
 * The division of labor is the same one philosophy.ts already establishes and this module does not
 * relax: the model proposes, code owns the record. Code owns the requirement ids, the coverage
 * enum, which entity ids are real, the question cap, and -- the one that matters most -- the rule
 * that a question about a technology never becomes evidence for that technology.
 */

import { type LlmEnv, type Provider, callStructured } from "./llm.ts";
import { getManagedPrompt } from "./langfuse.ts";
import { STRENGTHEN_QUESTIONS_PROMPT } from "./prompts.ts";
import {
  type CoverageItem,
  type EvidencePlan,
  type JobRequirements,
  RESUME_GUIDANCE,
  extractJobRequirements,
  planEvidence,
} from "./philosophy.ts";
import {
  type CareerProfile,
  IMPROVE_ANSWER_TYPES,
  IMPROVE_QUESTION_CATEGORIES,
  isValidProfileEntity,
  listProfileEntities,
  renderCareerProfile,
} from "./profile.ts";

// ---------------------------------------------------------------------------
// The persisted artifact
// ---------------------------------------------------------------------------

/**
 * The structured job-requirement -> profile-evidence -> gap mapping for one posting.
 *
 * Stored as one row in `job_evidence_analysis` and read by three consumers: the Strengthen page,
 * the resume writer, and the cover-letter writer. `requirements` and `plan` are kept as separate
 * fields rather than flattened together because `requirements` is a property of the *posting*
 * (stable until the posting changes) while `plan` is a property of the posting *crossed with the
 * current profile* (legitimately changes every time the profile gains evidence) -- which is exactly
 * why a reassessment recomputes the second and not the first.
 */
export type JobEvidenceAnalysis = {
  requirements: JobRequirements;
  plan: EvidencePlan;
  /** Fingerprint of the profile `plan` was computed against, so staleness is detectable. */
  profile_version: string;
  analyzed_at: string;
};

export type CoverageCounts = { proven: number; partial: number; unproven: number };

// ---------------------------------------------------------------------------
// Stage D -- targeted clarification questions
// ---------------------------------------------------------------------------

export type StrengthenQuestion = {
  id: string;
  /** Which requirement this question is trying to find evidence for. Empty for a general one. */
  requirement_id: string;
  requirement_text: string;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  target_field: string;
  category: string;
  priority: number;
  question: string;
  why_it_matters: string;
  answer_type: string;
};

/**
 * Cap on questions per run. The point of a job-scoped audit is that it is short enough to actually
 * finish in one sitting -- a page of 30 questions gets abandoned, which uncovers no evidence at all.
 */
const MAX_QUESTIONS = 12;

export const STRENGTHEN_QUESTIONS_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description:
        "Targeted questions, highest value first. Only ask where an answer could plausibly " +
        "uncover real evidence this candidate actually has. Fewer, sharper questions beat more.",
      items: {
        type: "object",
        properties: {
          requirement_id: {
            type: "string",
            description:
              "The id of the requirement this question is chasing evidence for, copied exactly " +
              "from the requirement list given to you. Empty string only for a question that is " +
              "genuinely not about any one requirement.",
          },
          entity_type: {
            type: "string",
            description:
              "The kind of profile entity this question is about, copied from the entity id list: " +
              "work_experience, work_experience_project, work_experience_achievement, education, " +
              "education_project, independent_project, research_and_publication, or 'profile' for " +
              "a career-wide question.",
          },
          entity_id: {
            type: "string",
            description:
              "The id of the specific profile entity this question is about, copied EXACTLY from " +
              "the career record. Empty only when entity_type is 'profile'. Never invent one.",
          },
          target_field: {
            type: "string",
            description:
              "Which kind of detail is missing, e.g. outcomes, metrics, scope_and_scale, " +
              "technologies, collaborators_and_stakeholders, responsibilities.",
          },
          category: { type: "string", enum: [...IMPROVE_QUESTION_CATEGORIES] },
          priority: {
            type: "integer",
            description: "0-100. Higher for requirements the posting treats as required.",
          },
          question: {
            type: "string",
            description:
              "The question itself, addressed to the candidate. It must name the specific role or " +
              "project it is asking about, and it must be answerable from memory.",
          },
          why_it_matters: {
            type: "string",
            description: "One short sentence: what this job asks for that the answer would evidence.",
          },
          answer_type: { type: "string", enum: [...IMPROVE_ANSWER_TYPES] },
        },
        required: [
          "requirement_id", "entity_type", "entity_id", "target_field",
          "category", "priority", "question", "why_it_matters", "answer_type",
        ],
      },
    },
  },
  required: ["questions"],
} as const;

/**
 * Renders the coverage report into the form the question generator reasons over.
 *
 * Deliberately includes the proven rows as well as the weak ones. A generator shown only the gaps
 * re-asks about things the record already proves, because it cannot see that they are covered --
 * and re-asking a question the candidate has effectively already answered is the single fastest way
 * to make this feature feel useless on the fifth job.
 */
export function renderCoverageForQuestions(analysis: JobEvidenceAnalysis): string {
  const byText = new Map(analysis.plan.coverage.map((c) => [c.requirement, c] as const));
  const lines = analysis.requirements.requirements.map((r) => {
    const c = byText.get(r.text);
    const status = c?.status ?? "unproven";
    const evidence = c?.evidence ? ` | evidence found: ${c.evidence}` : " | evidence found: none";
    return `- id=${r.id} [${r.kind}] [${status}] ${r.text}${evidence}`;
  });
  return lines.join("\n");
}

/** The entity ids a question is allowed to target, shown so the model cannot invent one. */
function renderEntityIds(profile: CareerProfile): string {
  const entities = listProfileEntities(profile);
  if (!entities.length) return "(the profile has no entities yet)";
  return entities.map((e) => `- ${e.entity_type} | ${e.entity_id} | ${e.entity_label}`).join("\n");
}

/**
 * Prior job-scoped and profile-wide question state, so a second posting does not re-ask the first
 * posting's questions.
 *
 * This is the mechanism behind the cumulative-benefit property: the questions are stored against
 * the profile, not against the job, so an answer given for job A is visible when job B is analyzed.
 */
export function renderPriorQuestionState(
  prior: { entity_label: string; entity_type: string; target_field: string; category: string; question: string; answer: string; status: string }[],
): string {
  if (!prior.length) return "(nothing has been asked of this candidate before)";
  return prior
    .map(
      (q) =>
        `[${q.status}] ${q.entity_label || q.entity_type} / ${q.target_field || q.category}: "${q.question}"` +
        (q.answer ? ` -> answered: "${q.answer}"` : ""),
    )
    .join("\n");
}

/**
 * Stage D: turn graded coverage into questions worth asking.
 *
 * Returns [] rather than throwing when the model call fails. A failed question pass still leaves a
 * complete, useful analysis on the page (requirements, evidence, coverage) -- degrading to "no
 * questions this time" is much better than failing the whole Strengthen run over the optional half.
 */
export async function generateClarificationQuestions(
  env: LlmEnv,
  provider: Provider,
  profile: CareerProfile,
  analysis: JobEvidenceAnalysis,
  job: { title: string; company: string },
  priorQuestionState: string,
): Promise<StrengthenQuestion[]> {
  const prompt = await getManagedPrompt(
    env,
    "job/strengthen-questions",
    {
      job_title: job.title,
      company: job.company,
      role_summary: analysis.requirements.role_summary,
      requirement_coverage: renderCoverageForQuestions(analysis),
      career_profile: renderCareerProfile(profile),
      profile_entity_ids: renderEntityIds(profile),
      prior_question_state: priorQuestionState,
      resume_guidance: RESUME_GUIDANCE,
    },
    STRENGTHEN_QUESTIONS_PROMPT,
  );

  const raw = await callStructured<{ questions?: unknown }>(
    env,
    provider,
    "strengthen.questions",
    prompt,
    STRENGTHEN_QUESTIONS_SCHEMA,
    "submit_questions",
    6000,
  );
  return normalizeStrengthenQuestions(raw?.questions, profile, analysis);
}

/**
 * Code owns which questions survive.
 *
 * Three things are enforced here rather than trusted to the prompt:
 *  1. A question targeting an entity id that is not in the profile is dropped. A question about a
 *     role the candidate does not have is nonsense to read, and worse, its answer would later be
 *     merged onto a nonexistent entity.
 *  2. A question naming a requirement id the analysis does not contain loses that link (it is kept
 *     as a general question rather than pointing at nothing).
 *  3. Requirements the record already *proves* are not eligible for questions at all, unless the
 *     question is chasing a missing metric or outcome -- which is the one case the brief explicitly
 *     carves out, and the one case where guidance says a strong bullet is still improvable.
 */
export function normalizeStrengthenQuestions(
  raw: unknown,
  profile: CareerProfile,
  analysis: JobEvidenceAnalysis,
): StrengthenQuestion[] {
  if (!Array.isArray(raw)) return [];

  const requirementById = new Map(analysis.requirements.requirements.map((r) => [r.id, r] as const));
  const statusByText = new Map(analysis.plan.coverage.map((c) => [c.requirement, c.status] as const));
  const metricFields = new Set(["metrics", "outcomes", "scope_and_scale", "decisions_enabled"]);

  const out: StrengthenQuestion[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const q = item as Record<string, unknown>;
    const question = String(q?.question ?? "").trim();
    if (!question) continue;

    const entityType = String(q?.entity_type ?? "").trim() || "profile";
    const entityId = String(q?.entity_id ?? "").trim();
    // "profile" means career-wide and legitimately carries no entity id; anything else must name a
    // real entity, or the answer has nowhere truthful to land.
    if (entityType !== "profile" && !isValidProfileEntity(profile, entityType, entityId)) continue;

    const requirementId = String(q?.requirement_id ?? "").trim();
    const requirement = requirementById.get(requirementId) ?? null;
    const targetField = String(q?.target_field ?? "").trim();

    if (requirement) {
      const status = statusByText.get(requirement.text) ?? "unproven";
      // Already proven, and not chasing a number or an outcome -> nothing useful to learn.
      if (status === "proven" && !metricFields.has(targetField)) continue;
    }

    const dedupeKey = `${entityType}|${entityId}|${targetField.toLowerCase()}|${requirementId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const rawPriority = Number(q?.priority);
    out.push({
      id: crypto.randomUUID(),
      requirement_id: requirement?.id ?? "",
      requirement_text: requirement?.text ?? "",
      entity_type: entityType,
      entity_id: entityType === "profile" ? "" : entityId,
      entity_label: entityLabelFor(profile, entityType, entityId),
      target_field: targetField,
      category: IMPROVE_QUESTION_CATEGORIES.includes(String(q?.category ?? "") as never)
        ? String(q!.category)
        : "other",
      priority: Number.isFinite(rawPriority) ? Math.max(0, Math.min(100, Math.round(rawPriority))) : 0,
      question,
      why_it_matters: String(q?.why_it_matters ?? "").trim(),
      answer_type: IMPROVE_ANSWER_TYPES.includes(String(q?.answer_type ?? "") as never)
        ? String(q!.answer_type)
        : "long_text",
    });
  }

  return out.sort((a, b) => b.priority - a.priority).slice(0, MAX_QUESTIONS);
}

function entityLabelFor(profile: CareerProfile, entityType: string, entityId: string): string {
  if (entityType === "profile") return "Career-wide";
  const match = listProfileEntities(profile).find(
    (e) => e.entity_type === entityType && e.entity_id === entityId,
  );
  return match?.entity_label ?? "";
}

// ---------------------------------------------------------------------------
// Stages A-C / G -- analysis and reassessment
// ---------------------------------------------------------------------------

/**
 * Runs stages A-C for one posting and returns the artifact to persist.
 *
 * `cachedRequirements` skips stage A when the posting has already been read once. A posting's
 * stated requirements do not change between the first Strengthen run and a later reassessment, so
 * re-extracting them buys nothing and costs a model call; the plan, which does depend on the
 * current profile, is always recomputed.
 */
export async function analyzeJobEvidence(
  env: LlmEnv,
  provider: Provider,
  job: { title: string; company: string; description: string },
  profile: CareerProfile,
  profileVersion: string,
  cachedRequirements: JobRequirements | null,
): Promise<JobEvidenceAnalysis | null> {
  const requirements = cachedRequirements?.requirements?.length
    ? cachedRequirements
    : await extractJobRequirements(env, provider, job);
  if (!requirements.requirements.length) return null;

  const plan = await planEvidence(env, provider, profile, requirements, `${job.title} at ${job.company}`);
  return {
    requirements,
    plan,
    profile_version: profileVersion,
    analyzed_at: new Date().toISOString(),
  };
}

export function coverageCounts(plan: EvidencePlan): CoverageCounts {
  return {
    proven: plan.coverage.filter((c) => c.status === "proven").length,
    partial: plan.coverage.filter((c) => c.status === "partial").length,
    unproven: plan.coverage.filter((c) => c.status === "unproven").length,
  };
}

/** Parses a stored artifact, returning null for the pre-Strengthen rows that have none. */
export function readJobEvidenceAnalysis(json: string | null | undefined): JobEvidenceAnalysis | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as JobEvidenceAnalysis;
    if (!parsed?.requirements?.requirements?.length || !parsed?.plan?.coverage) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Downstream handoff -- what resume and cover letter actually read
// ---------------------------------------------------------------------------

/**
 * The analysis rendered for the cover-letter writer.
 *
 * Different shape from the resume's `renderPlanDirective` on purpose. A resume needs a per-role
 * space budget and a full requirement checklist; a letter needs the opposite -- the two or three
 * strongest genuine connections, and a hard prohibition on the rest. Handing the letter writer the
 * resume's directive would produce exactly the failure the brief calls out: a letter that
 * paraphrases the resume.
 */
export function renderCoverLetterEvidence(analysis: JobEvidenceAnalysis): string {
  const lines: string[] = [];
  if (analysis.requirements.role_summary) {
    lines.push(`WHAT THIS ROLE ACTUALLY IS: ${analysis.requirements.role_summary}`, "");
  }

  const rank = (c: CoverageItem) => (c.kind === "must_have" ? 0 : c.kind === "responsibility" ? 1 : 2);
  const proven = analysis.plan.coverage.filter((c) => c.status === "proven").sort((a, b) => rank(a) - rank(b));
  const partial = analysis.plan.coverage.filter((c) => c.status === "partial").sort((a, b) => rank(a) - rank(b));
  const unproven = analysis.plan.coverage.filter((c) => c.status === "unproven");

  if (proven.length) {
    lines.push(
      "STRONGEST GENUINE CONNECTIONS (already verified against the candidate's record, most",
      "important to this employer first). Choose the two or three that make the best letter and",
      "develop them properly -- do not list all of them, and do not simply restate the resume:",
      ...proven.map((c) => `- ${c.requirement} <- ${c.evidence}`),
      "",
    );
  }

  if (partial.length) {
    lines.push(
      "PARTIAL MATCHES -- the candidate has adjacent experience, not the exact thing asked for. Only",
      "mention one of these if it genuinely helps, and describe the adjacent work by its real name",
      "rather than implying the exact match:",
      ...partial.map((c) => `- asked for: ${c.requirement} | closest real experience: ${c.evidence}`),
      "",
    );
  }

  if (unproven.length) {
    lines.push(
      "NOT SUPPORTED BY THE RECORD. Write nothing that claims, implies, or hints at any of these.",
      "Do not reach for a loosely related accomplishment to gesture at them, and do not express",
      "enthusiasm in a way that reads as a claim of experience:",
      ...unproven.map((c) => `- ${c.requirement}`),
    );
  }

  return lines.join("\n").trim();
}
