/**
 * Every place this app talks to a model, named once.
 *
 * Each model call passes its task id to the transport, and the transport stamps that id onto the
 * trace it records. That gives a stable key to group by: "what does screening cost per posting",
 * "which task is slowest", "did the cover-letter prompt get worse after the last change". Without
 * it, traces are a flat list of calls with no way to tell which pipeline stage produced them.
 *
 * The registry exists so the dev console can describe the pipeline rather than just listing
 * whatever ids happen to appear in the data -- a task with no traces yet should still show up,
 * since "this call has never run" is itself worth seeing.
 */

import type { Tier } from "./llm";

export type LlmTaskId =
  | "fit.screen"
  | "fit.assess"
  | "fit.criteria"
  | "profile.structure"
  | "profile.create"
  | "profile.improve_audit"
  | "profile.improve_apply"
  | "roles.analyze"
  | "roles.research"
  | "review.question"
  | "resume.build"
  | "resume.requirements"
  | "resume.plan_evidence"
  | "resume.design_review"
  | "resume.select_base"
  | "cover_letter.write"
  | "application.answers"
  | "evals.judge";

export type LlmTaskInfo = {
  id: LlmTaskId;
  /** Short human name, for the console's task list. */
  name: string;
  /** Which pipeline stage this belongs to, for grouping. */
  stage: "Find matches" | "Profile" | "Apply" | "Developer tools";
  tier: Tier;
  /** What the call is asked to do, and what shape comes back. */
  what: string;
  /** Where the prompt is built, so the console links thinking to code. */
  source: string;
  /**
   * How many postings/items one call covers. Batched calls are the reason per-call cost is
   * misleading on its own -- one screen call covering 60 postings is cheap per posting and
   * expensive per call, and the console needs to say which it is showing.
   */
  batched: boolean;
  /**
   * Whether this call's prompt is a plain rendered string the eval harness can resend verbatim.
   * False only for `resume.design_review` (it also sends a screenshot, which traces never store)
   * and `evals.judge` itself (its prompt is generated from an eval run, not saved as a case).
   */
  replayable: boolean;
};

export const LLM_TASKS: LlmTaskInfo[] = [
  {
    id: "fit.screen",
    name: "Cheap screen",
    stage: "Find matches",
    tier: "screen",
    what: "Title and location only, in batches of 60. Decides which postings are worth reading in full.",
    source: "src/fit.ts -> screenJobsBatch",
    batched: true,
    replayable: true,
  },
  {
    id: "fit.assess",
    name: "Full fit assessment",
    stage: "Find matches",
    tier: "reason",
    what: "Whole posting text against the profile, in batches of 8. Produces the 0-100 score, the reason, and the quick facts.",
    source: "src/fit.ts -> assessJobFitBatch",
    batched: true,
    replayable: true,
  },
  {
    id: "fit.criteria",
    name: "Interpret criteria",
    stage: "Profile",
    tier: "screen",
    what: "Turns the free-text field into canonical {label, looking_for} topics. Runs once per save, not per posting.",
    source: "src/fit.ts -> deriveCareAboutTopics",
    batched: false,
    replayable: true,
  },
  {
    id: "profile.structure",
    name: "Structure the profile (legacy)",
    stage: "Profile",
    tier: "reason",
    what: "Pre-schema-v3 name for building the canonical CareerProfile. Superseded by profile.create; kept only so old traces/eval cases remain labeled and replayable.",
    source: "src/index.ts -> generateProfile",
    batched: false,
    replayable: true,
  },
  {
    id: "profile.create",
    name: "Create the Career Evidence Record",
    stage: "Profile",
    tier: "reason",
    what: "Turns uploaded documents, notes, and applied Improve answers into the canonical CareerProfile (schema v3, with stable entity ids) every later stage reads from.",
    source: "src/index.ts -> generateProfile",
    batched: false,
    replayable: true,
  },
  {
    id: "profile.improve_audit",
    name: "Find profile improvements",
    stage: "Profile",
    tier: "reason",
    what: "Audits the structured profile plus prior question/answer state and proposes prioritized, entity-targeted questions about missing high-value evidence.",
    source: "src/index.ts -> runImproveAudit",
    batched: false,
    replayable: true,
  },
  {
    id: "profile.improve_apply",
    name: "Apply improve answers",
    stage: "Profile",
    tier: "reason",
    what: "Integrates saved Improve answers into the canonical profile -- distributing multi-fact answers across fields, correcting explicit contradictions, never inventing facts.",
    source: "src/index.ts -> applyImproveAnswers",
    batched: false,
    replayable: true,
  },
  {
    id: "roles.analyze",
    name: "Analyze suitable roles",
    stage: "Profile",
    tier: "reason",
    what: "Structured. Reads the full career profile plus preferences, good/bad examples, locations, deal breakers and priorities; writes a role-independent summary plus the distinct role families worth searching for.",
    source: "src/index.ts -> analyzeDesiredRoles",
    batched: false,
    replayable: true,
  },
  {
    id: "roles.research",
    name: "Research a role's market",
    stage: "Profile",
    tier: "reason",
    what: "Structured. Reads labor-market documents retrieved from external sources and reports only what they support -- never salary or outlook figures recalled from training data.",
    source: "src/market.ts -> researchRoleMarket",
    batched: false,
    replayable: false,
  },
  {
    id: "review.question",
    name: "Ask a gap question",
    stage: "Apply",
    tier: "reason",
    what: "Free text. One conversational question about whatever the posting wants that the profile does not yet cover.",
    source: "src/index.ts -> jobReviewQuestion",
    batched: false,
    replayable: true,
  },
  {
    id: "resume.build",
    name: "Build tailored resume",
    stage: "Apply",
    tier: "reason",
    what: "Writes the resume document for one posting, grounded in stored evidence.",
    source: "src/resume.ts -> buildJobResume",
    batched: false,
    replayable: true,
  },
  {
    id: "resume.requirements",
    name: "Extract job requirements",
    stage: "Apply",
    tier: "reason",
    what: "Breaks one posting into its separate stated requirements, classified as must-have, responsibility, preferred, or competency.",
    source: "src/philosophy.ts -> extractJobRequirements",
    batched: false,
    replayable: true,
  },
  {
    id: "resume.plan_evidence",
    name: "Plan resume evidence",
    stage: "Apply",
    tier: "reason",
    what: "Decides feature/include/compress/omit per past role against those requirements, and reports which are proven, partial, or unproven.",
    source: "src/philosophy.ts -> planEvidence",
    batched: false,
    replayable: true,
  },
  {
    id: "resume.design_review",
    name: "Review resume layout",
    stage: "Apply",
    tier: "reason",
    what: "Looks at a rendered screenshot of the PDF and critiques the layout. The only call that sends an image.",
    source: "src/resume.ts -> reviewResumeDesign",
    batched: false,
    replayable: false,
  },
  {
    id: "resume.select_base",
    name: "Pick a base resume",
    stage: "Apply",
    tier: "reason",
    what: "Chooses which stored resume to tailor from, and notes what to change.",
    source: "src/index.ts -> jobResume",
    batched: false,
    replayable: true,
  },
  {
    id: "cover_letter.write",
    name: "Write cover letter",
    stage: "Apply",
    tier: "reason",
    what: "Writes the letter body for one posting.",
    source: "src/index.ts -> jobCoverLetter",
    batched: false,
    replayable: true,
  },
  {
    id: "application.answers",
    name: "Fill application answers",
    stage: "Apply",
    tier: "reason",
    what: "Answers an application form's questions from the saved answer bank and profile.",
    source: "src/index.ts -> matchApplication",
    batched: true,
    replayable: true,
  },
  {
    id: "evals.judge",
    name: "Score an eval run",
    stage: "Developer tools",
    tier: "reason",
    what: "Given a task's purpose, the exact prompt sent, and the response it produced, scores 0-100 how well the response satisfies the task.",
    source: "src/evals.ts -> judgeRun",
    batched: false,
    replayable: false,
  },
];

export function taskInfo(id: string): LlmTaskInfo | null {
  return LLM_TASKS.find((task) => task.id === id) ?? null;
}
