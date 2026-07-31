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

export const FIT_BATCH_SIZE = 8;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
