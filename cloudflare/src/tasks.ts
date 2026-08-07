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
  | "fit.care_about_topics"
  | "companies.discover"
  | "profile.structure"
  | "roles.describe"
  | "review.question"
  | "resume.build"
  | "resume.design_review"
  | "resume.select_base"
  | "cover_letter.write"
  | "application.answers";

export type LlmTaskInfo = {
  id: LlmTaskId;
  /** Short human name, for the console's task list. */
  name: string;
  /** Which pipeline stage this belongs to, for grouping. */
  stage: "Find matches" | "Profile" | "Apply";
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
  },
  {
    id: "fit.assess",
    name: "Full fit assessment",
    stage: "Find matches",
    tier: "reason",
    what: "Whole posting text against the profile, in batches of 8. Produces the 0-100 score, the reason, and the quick facts.",
    source: "src/fit.ts -> assessJobFitBatch",
    batched: true,
  },
  {
    id: "fit.care_about_topics",
    name: "Interpret 'what I care about'",
    stage: "Profile",
    tier: "screen",
    what: "Turns the free-text field into canonical {label, looking_for} topics. Runs once per save, not per posting.",
    source: "src/fit.ts -> deriveCareAboutTopics",
    batched: false,
  },
  {
    id: "companies.discover",
    name: "Suggest companies",
    stage: "Find matches",
    tier: "reason",
    what: "Proposes companies worth watching, given the desired-roles description.",
    source: "src/companies.ts -> discoverCompanies",
    batched: true,
  },
  {
    id: "profile.structure",
    name: "Structure the profile",
    stage: "Profile",
    tier: "reason",
    what: "Turns uploaded documents and notes into the structured candidate profile everything else reads from.",
    source: "src/index.ts -> saveStructuredProfile",
    batched: false,
  },
  {
    id: "roles.describe",
    name: "Draft desired roles",
    stage: "Profile",
    tier: "reason",
    what: "Free text. Writes the desired-roles description from loose notes and saved links.",
    source: "src/index.ts -> generateDesiredRoles",
    batched: false,
  },
  {
    id: "review.question",
    name: "Ask a gap question",
    stage: "Apply",
    tier: "reason",
    what: "Free text. One conversational question about whatever the posting wants that the profile does not yet cover.",
    source: "src/index.ts -> jobReviewQuestion",
    batched: false,
  },
  {
    id: "resume.build",
    name: "Build tailored resume",
    stage: "Apply",
    tier: "reason",
    what: "Writes the resume document for one posting, grounded in stored evidence.",
    source: "src/resume.ts -> buildJobResume",
    batched: false,
  },
  {
    id: "resume.design_review",
    name: "Review resume layout",
    stage: "Apply",
    tier: "reason",
    what: "Looks at a rendered screenshot of the PDF and critiques the layout. The only call that sends an image.",
    source: "src/resume.ts -> reviewResumeDesign",
    batched: false,
  },
  {
    id: "resume.select_base",
    name: "Pick a base resume",
    stage: "Apply",
    tier: "reason",
    what: "Chooses which stored resume to tailor from, and notes what to change.",
    source: "src/index.ts -> jobResume",
    batched: false,
  },
  {
    id: "cover_letter.write",
    name: "Write cover letter",
    stage: "Apply",
    tier: "reason",
    what: "Writes the letter body for one posting.",
    source: "src/index.ts -> jobCoverLetter",
    batched: false,
  },
  {
    id: "application.answers",
    name: "Fill application answers",
    stage: "Apply",
    tier: "reason",
    what: "Answers an application form's questions from the saved answer bank and profile.",
    source: "src/index.ts -> matchApplication",
    batched: true,
  },
];

export function taskInfo(id: string): LlmTaskInfo | null {
  return LLM_TASKS.find((task) => task.id === id) ?? null;
}
