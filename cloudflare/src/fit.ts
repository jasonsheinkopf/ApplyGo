// Job fit assessment.
//
// A keyword/location match tells you a posting is in the right category. It says nothing about
// whether the candidate is actually a plausible applicant -- a title match happily survives
// "PhD required" or "10+ years of C++" sitting three lines into the description. This is the
// stage that reads the actual requirements against the actual profile and says so.
//
// Same model-proposes/code-owns-the-record split as the rest of the app: the LLM produces a
// verdict and a reason, but only an explicit user action turns a rejection into a durable
// disqualifier fed back into future assessments. An AI misjudgment that never gets confirmed by
// the user can't reinforce itself into a permanent rule -- see index.ts's job_feedback writes.

import { type LlmEnv, type Provider, callStructured } from "./llm";

/** The subset of the profile that matters for judging a job. Structurally compatible with StructuredProfile. */
type ProfileForMatching = {
  headline?: string;
  narrative_summary?: string;
  skills?: string[];
  experience?: { company: string; title: string; start: string; end: string }[];
  education?: { school: string; degree: string; field: string; end_year: string }[];
};

/**
 * A short rendering of the profile, used as the candidate half of every match call.
 *
 * Built deterministically rather than generated: it costs nothing, it is identical on every run,
 * and it cannot drift out of sync with the profile it describes the way a cached LLM summary
 * would. The full structured profile runs several thousand characters and gets re-sent with
 * every screening batch, which is exactly the input worth shrinking.
 */
export function buildMatchProfile(profile: ProfileForMatching): string {
  const lines: string[] = [];
  if (profile.headline) lines.push(profile.headline);

  const summary = (profile.narrative_summary ?? "").trim();
  if (summary) lines.push(summary.length > 400 ? summary.slice(0, 400).trimEnd() + "…" : summary);

  const roles = (profile.experience ?? []).slice(0, 6).map((e) => {
    const span = [e.start, e.end].filter(Boolean).join("–");
    return `${e.title} at ${e.company}${span ? ` (${span})` : ""}`;
  });
  if (roles.length) lines.push(`Experience: ${roles.join("; ")}`);

  const degrees = (profile.education ?? []).slice(0, 3).map((e) => {
    const what = [e.degree, e.field].filter(Boolean).join(" in ");
    return `${what || "Study"}, ${e.school}${e.end_year ? ` ${e.end_year}` : ""}`;
  });
  if (degrees.length) lines.push(`Education: ${degrees.join("; ")}`);

  const skills = (profile.skills ?? []).slice(0, 40);
  if (skills.length) lines.push(`Skills: ${skills.join(", ")}`);

  return lines.join("\n").slice(0, 2000);
}

export type FitVerdict = "strong" | "possible" | "reject";

export type JobToAssess = {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string;
};

export type FitResult = {
  id: string;
  verdict: FitVerdict;
  reason: string;
  missing: string[];
};

const FIT_BATCH_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Must exactly match the job's id as given." },
          verdict: {
            type: "string",
            enum: ["strong", "possible", "reject"],
            description:
              "strong: solid overlap between the posting's actual requirements and the candidate's evidence. " +
              "possible: a genuine stretch or a posting too vague to rule out -- do not reject on a maybe. " +
              "reject: the posting states a requirement the candidate's profile clearly does not meet " +
              "(a specific language/tool they have no evidence of, a degree they don't hold, years of " +
              "experience far beyond what their history shows).",
          },
          reason: {
            type: "string",
            description:
              "One sentence, citing the specific requirement and the specific (mis)match against the profile. " +
              "Not a generic summary of the job.",
          },
          missing: {
            type: "array",
            items: { type: "string" },
            description: "Specific requirements the candidate doesn't evidently meet. Empty if none.",
          },
        },
        required: ["id", "verdict", "reason", "missing"],
      },
    },
  },
  required: ["results"],
} as const;

function fitPrompt(
  profileJson: string,
  desiredRoles: string,
  disqualifiers: string[],
  jobs: JobToAssess[],
): string {
  return [
    "You are screening job postings for a candidate against their own verified profile -- the same",
    "kind of judgment call a careful applicant makes before spending time on a posting, not a",
    "generic keyword match.",
    "",
    "For each posting, decide strong, possible, or reject. Be decisive: 'reject' is for a stated",
    "requirement the profile clearly does not satisfy, not for general uncertainty. A posting with",
    "no explicit disqualifying requirement should be 'possible' or 'strong', even if it's a stretch",
    "-- the candidate would rather see a long-shot than miss it. Only reject on requirements the",
    "posting actually states (a specific language or tool, a degree, a minimum years of experience),",
    "not on assumptions about culture fit, company size, or anything the posting doesn't say.",
    "",
    disqualifiers.length
      ? [
          "The candidate has previously confirmed these were NOT a fit, and why -- weigh a posting",
          "with a similar stated requirement accordingly:",
          ...disqualifiers.map((d) => `- ${d}`),
          "",
        ].join("\n")
      : "",
    desiredRoles ? `TARGET ROLES:\n${desiredRoles}\n` : "",
    `CANDIDATE PROFILE:\n${profileJson}`,
    "",
    `POSTINGS TO ASSESS:\n${JSON.stringify(
      jobs.map((j) => ({
        id: j.id,
        title: j.title,
        company: j.company,
        location: j.location,
        description: j.description.slice(0, 1500),
      })),
    )}`,
    "",
    "Return one result per posting, in any order, each with the matching id.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Assesses one batch (small enough for a single prompt) and returns a verdict per job, defaulting
 * to a fail-open "possible" for anything the model doesn't return a result for -- an assessment
 * gap should never silently hide a posting the candidate never got to see.
 */
export async function assessJobFitBatch(
  env: LlmEnv,
  provider: Provider,
  profileJson: string,
  desiredRoles: string,
  disqualifiers: string[],
  jobs: JobToAssess[],
): Promise<FitResult[]> {
  if (!jobs.length) return [];
  const { results } = await callStructured<{ results: FitResult[] }>(
    env,
    provider,
    fitPrompt(profileJson, desiredRoles, disqualifiers, jobs),
    FIT_BATCH_SCHEMA,
    "submit_fit_assessment",
    4000,
  );
  const byId = new Map(results.map((r) => [r.id, r]));
  return jobs.map((job) => {
    const found = byId.get(job.id);
    if (!found) return { id: job.id, verdict: "possible", reason: "Not individually assessed.", missing: [] };
    const verdict: FitVerdict = ["strong", "possible", "reject"].includes(found.verdict)
      ? found.verdict
      : "possible";
    return { id: job.id, verdict, reason: found.reason ?? "", missing: found.missing ?? [] };
  });
}

// ---------------------------------------------------------------------------
// Tier 1 -- cheap bulk screen
// ---------------------------------------------------------------------------

export type ScreenResult = { id: string; keep: boolean; note: string };

const SCREEN_BATCH_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Must exactly match the posting's id as given." },
          keep: {
            type: "boolean",
            description:
              "true if this candidate could plausibly be considered for the role. false only when the " +
              "posting is clearly wrong for them -- a different profession, a seniority far outside their " +
              "range, or a stated hard requirement they obviously lack.",
          },
          note: { type: "string", description: "At most 8 words on why, only when keep is false." },
        },
        required: ["id", "keep", "note"],
      },
    },
  },
  required: ["results"],
} as const;

/**
 * The cheap pass. Runs a small model over many postings at once with only a title, location and
 * the opening of each description, and asks a single yes/no question. Deliberately biased toward
 * keeping: this tier exists to remove the obvious misses before the expensive tier runs, and a
 * wrong "drop" here is invisible to the user, so ambiguity must survive to the next stage.
 */
export async function screenJobsBatch(
  env: LlmEnv,
  provider: Provider,
  matchProfile: string,
  desiredRoles: string,
  disqualifiers: string[],
  jobs: JobToAssess[],
): Promise<ScreenResult[]> {
  if (!jobs.length) return [];
  const prompt = [
    "Decide which of these job postings are worth a closer look for this candidate.",
    "",
    "Keep anything plausible. Drop only clear mismatches: a different profession entirely, a",
    "seniority far outside their range, or a stated hard requirement they obviously lack.",
    "When unsure, keep it -- a later, more careful pass will make the real call.",
    "",
    disqualifiers.length
      ? `The candidate has already rejected roles for these reasons:\n${disqualifiers.map((d) => `- ${d}`).join("\n")}\n`
      : "",
    desiredRoles ? `WANTS: ${desiredRoles.slice(0, 600)}\n` : "",
    `CANDIDATE:\n${matchProfile}`,
    "",
    `POSTINGS:\n${JSON.stringify(
      jobs.map((j) => ({ id: j.id, title: j.title, location: j.location, snippet: j.description.slice(0, 500) })),
    )}`,
    "",
    "Return one result per posting.",
  ]
    .filter(Boolean)
    .join("\n");

  const { results } = await callStructured<{ results: ScreenResult[] }>(
    env,
    provider,
    prompt,
    SCREEN_BATCH_SCHEMA,
    "submit_screen",
    2000,
    "screen",
  );
  const byId = new Map((results ?? []).map((r) => [r.id, r]));
  // Anything the model didn't return survives to the next tier rather than being dropped silently.
  return jobs.map((job) => {
    const found = byId.get(job.id);
    if (!found) return { id: job.id, keep: true, note: "" };
    return { id: job.id, keep: found.keep !== false, note: found.note ?? "" };
  });
}

export const SCREEN_BATCH_SIZE = 25;
export const FIT_BATCH_SIZE = 8;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
