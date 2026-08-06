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

import { type LlmEnv, type Provider, WRITING_STYLE_RULES, callStructured } from "./llm";

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
  score: number;
  reason: string;
  missing: string[];
  years_required: string;
  remote: string;
  salary: string;
};

/**
 * The strong tier rates every posting it sees on a 0-100 scale rather than a three-way label, so
 * the Jobs tab can offer a real threshold instead of a fixed bucket. The bucket is still derived
 * from it (for the existing hide/show/sort logic, which only needs to know strong/possible/reject),
 * but the underlying number is what's actually stored and shown.
 *
 * Thresholds aren't arbitrary: below 40 lines up with what "reject" already meant -- a stated hard
 * requirement the profile doesn't meet lands here regardless of how good the rest of the match is,
 * per FIT_SCORE_GUIDANCE below. 40-69 is a genuine stretch worth seeing; 70+ is a strong overlap.
 */
export function verdictForScore(score: number): FitVerdict {
  if (score >= 70) return "strong";
  if (score >= 40) return "possible";
  return "reject";
}

const FIT_SCORE_GUIDANCE = [
  "Score each posting 0-100 for how well it fits this specific candidate, not how good the job is",
  "in the abstract. Calibrate roughly like this:",
  "  90-100: exceptional overlap, this is exactly their evident experience and level.",
  "  70-89:  strong match, solidly within their demonstrated experience.",
  "  40-69:  a genuine stretch or a posting too vague to be sure -- worth seeing, not a clear miss.",
  "  15-39:  a real mismatch on the posting's own terms, but not a flatly stated disqualifier.",
  "  0-14:   the posting states a hard requirement the profile clearly does not meet (a specific",
  "          language/tool with no evidence of it, a degree not held, years of experience far",
  "          beyond their history) -- score low here regardless of how good the rest looks, a",
  "          single hard disqualifier should not be averaged away by an otherwise strong overlap.",
  "Use the full range. Do not default to the middle when uncertain -- say what's actually uncertain",
  "in the reason instead of hedging the number.",
].join("\n");

const FIT_BATCH_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Must exactly match the job's id as given." },
          score: { type: "integer", minimum: 0, maximum: 100, description: "0-100 fit score. See scoring guidance." },
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
          years_required: {
            type: "string",
            description:
              "The years of experience this posting states as REQUIRED (not preferred/desired), as stated or " +
              "closely paraphrased, e.g. '5+ years' or '3-5 years'. Empty string if the posting states no " +
              "experience requirement at all.",
          },
          remote: {
            type: "string",
            description: "One of: Remote, Hybrid, Onsite, or empty string if the posting doesn't say.",
          },
          salary: {
            type: "string",
            description:
              "Any stated compensation/salary range, as stated, e.g. '$140k-$180k + equity'. Empty string if " +
              "the posting doesn't state one -- never estimate or guess a figure that isn't actually written.",
          },
        },
        required: ["id", "score", "reason", "missing", "years_required", "remote", "salary"],
      },
    },
  },
  required: ["results"],
} as const;

/**
 * A years-of-experience gap is one of the few requirements precise enough to reason about
 * numerically, so it gets a concrete rule rather than being left to "far beyond" judgment calls
 * -- which in practice let postings needing roughly double the candidate's actual experience
 * through as a "stretch". Calibrated to what actually reads as fine vs. not: needing 5 when you
 * have 3 is a normal reach; needing 7 when you have 3 is a different job level entirely.
 */
function experienceGapRule(currentYear: number): string {
  return [
    "Years-of-experience requirements get a concrete rule, since they're precise enough to reason",
    "about numerically rather than qualitatively: when a posting states a minimum (e.g. '7+ years'),",
    `estimate the candidate's actual total years of relevant professional experience from their work`,
    `history's start/end years (treat "Present" as ${currentYear}). A gap of up to 2 years is a normal,`,
    "fine stretch -- do not reject for it alone (needing 5 years when they have 3 is fine). A gap of",
    "more than 2 years is a genuine mismatch and should be rejected, citing the specific gap (needing",
    "7+ years when they have about 3 is a different seniority level, not a stretch).",
  ].join("\n");
}

function fitPrompt(
  profileJson: string,
  desiredRoles: string,
  disqualifiers: string[],
  customPreferences: string,
  jobs: JobToAssess[],
): string {
  return [
    "You are screening job postings for a candidate against their own verified profile -- the same",
    "kind of judgment call a careful applicant makes before spending time on a posting, not a",
    "generic keyword match.",
    "",
    WRITING_STYLE_RULES,
    "",
    FIT_SCORE_GUIDANCE,
    "",
    "Only score down for requirements the posting actually states (a specific language or tool, a",
    "degree, a minimum years of experience), not for assumptions about culture fit, company size, or",
    "anything the posting doesn't say.",
    "",
    experienceGapRule(new Date().getUTCFullYear()),
    "",
    // The one thing a candidate scrolling a list of these actually wants at a glance is whether the
    // years requirement is a problem -- burying it in the middle of a reason about other things
    // means they still have to open the real posting to find it, which defeats the point of scoring
    // it in the first place.
    "Whenever a posting states a required (not preferred) years-of-experience figure, say so plainly",
    "in `reason` itself, not just as a factor silently weighed into the score -- e.g. \"Requires 5+",
    "years; you have about 3, a real stretch\" or \"Requires 3-5 years, comfortably within your range\".",
    "",
    customPreferences
      ? [
          "The candidate wrote these matching preferences themselves, in their own words. Enforce them as",
          "binding rules with the same weight as a stated hard requirement above -- if a posting clearly",
          "violates one, that is a hard disqualifier regardless of how strong the rest of the overlap is:",
          customPreferences,
          "",
        ].join("\n")
      : "",
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
 * Assesses one batch (small enough for a single prompt) and returns a score per job, defaulting
 * to a fail-open 50 (the middle of the "possible" band) for anything the model doesn't return a
 * result for -- an assessment gap should never silently hide a posting the candidate never got to
 * see, the same way it never did back when the fail-open default was the "possible" verdict.
 */
export async function assessJobFitBatch(
  env: LlmEnv,
  provider: Provider,
  profileJson: string,
  desiredRoles: string,
  disqualifiers: string[],
  customPreferences: string,
  jobs: JobToAssess[],
): Promise<FitResult[]> {
  if (!jobs.length) return [];
  const { results } = await callStructured<{ results: FitResult[] }>(
    env,
    provider,
    fitPrompt(profileJson, desiredRoles, disqualifiers, customPreferences, jobs),
    FIT_BATCH_SCHEMA,
    "submit_fit_assessment",
    // Bumped alongside the richer per-posting schema (years_required/remote/salary) -- the previous
    // cap was sized for score/reason/missing alone and would risk truncating a full 8-item batch.
    5000,
  );
  const byId = new Map(results.map((r) => [r.id, r]));
  return jobs.map((job) => {
    const found = byId.get(job.id);
    if (!found) {
      return {
        id: job.id, score: 50, reason: "Not individually assessed.", missing: [],
        years_required: "", remote: "", salary: "",
      };
    }
    const score = Number.isFinite(found.score) ? Math.max(0, Math.min(100, Math.round(found.score))) : 50;
    return {
      id: job.id,
      score,
      reason: found.reason ?? "",
      missing: found.missing ?? [],
      years_required: found.years_required ?? "",
      remote: found.remote ?? "",
      salary: found.salary ?? "",
    };
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
 * The cheap pass. Runs a small model over many postings at once with only a title and location --
 * no description -- and asks a single yes/no question. Title and location are enough to catch what
 * this tier actually exists to catch: a different profession or field entirely (a "Propulsion
 * Engineer" posting isn't a software fit no matter what its description says). Deliberately biased
 * toward keeping: a wrong "drop" here is invisible to the user, so ambiguity must survive to the
 * next stage, which reads the full description and can catch a requirement the title didn't show.
 * Dropping the description is also what makes the large batch size below affordable -- the prompt
 * cost per posting is now just a title and a location, so far more fit in a single call.
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
    "Decide which of these job postings are worth a closer look for this candidate, based only on",
    "each posting's title and location -- you are not given a description.",
    "",
    "Keep anything plausible. Drop only clear mismatches obvious from the title alone: a different",
    "profession or field entirely (e.g. a mechanical/aerospace/hardware title against a software",
    "background), or a seniority word far outside their range (e.g. \"Staff\"/\"Director\" against an",
    "early-career profile, or \"Intern\"/\"Entry-Level\" against a senior one). If the title alone",
    "doesn't make the mismatch obvious, keep it -- the next stage reads the full posting.",
    "",
    // Only the dash rule here, not the full WRITING_STYLE_RULES block. This tier's entire output is
    // an eight-word fragment, and it runs at the highest volume of anything in the app (60 postings
    // per call, many calls), so the rest of the style guidance would be prompt cost buying nothing.
    "Never use an em dash (—) or en dash (–) in the note. Use a comma or start a new phrase.",
    "",
    disqualifiers.length
      ? `The candidate has already rejected roles for these reasons:\n${disqualifiers.map((d) => `- ${d}`).join("\n")}\n`
      : "",
    desiredRoles ? `WANTS: ${desiredRoles.slice(0, 600)}\n` : "",
    `CANDIDATE:\n${matchProfile}`,
    "",
    `POSTINGS:\n${JSON.stringify(jobs.map((j) => ({ id: j.id, title: j.title, location: j.location })))}`,
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
    // A 36-char id plus keep/note per posting adds up at 60 postings/call -- the previous 2000-token
    // cap was sized for a 25-item batch and would risk truncating a full one.
    4000,
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

export const SCREEN_BATCH_SIZE = 60;
export const FIT_BATCH_SIZE = 8;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
