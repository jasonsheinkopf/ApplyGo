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

import { type LlmEnv, type Provider, callStructured } from "./llm.ts";
import { getManagedPrompt } from "./langfuse.ts";
import { JOBS_PRESCREEN_PROMPT } from "./prompts.ts";
import { locationMatches } from "./companies.ts";

/**
 * The compact candidate rendering used by high-volume prescreening lives in src/profile.ts, next to
 * the canonical CareerProfile it summarizes, and is re-exported here so this module stays the one
 * import site for "everything about judging a job".
 *
 * Which rendering a call gets is a deliberate cost/fidelity decision, not an implementation detail:
 * the compact form is for the cheap screen that re-sends the candidate with every batch of
 * postings, while deep assessment and career analysis take the full record from
 * `renderCareerProfile` -- see its header comment for why that trade runs the way it does.
 */
export { buildMatchProfile } from "./profile.ts";

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
  facts: { label: string; value: string }[];
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

export const FIT_BATCH_SCHEMA = {
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
          facts: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description:
                    "Copied EXACTLY from the matching topic's label in QUICK FACTS TO REPORT. Never reword it, " +
                    "never substitute the candidate's original phrasing.",
                },
                value: {
                  type: "string",
                  description:
                    "This posting's actual stated value for that topic, as stated or closely paraphrased, kept " +
                    "short enough to read at a glance. 'Not specified' if the posting doesn't say -- never " +
                    "estimate or guess a value that isn't actually written.",
                },
              },
              required: ["label", "value"],
            },
            description:
              "Exactly one entry per topic listed in QUICK FACTS TO REPORT, in that same order, using those " +
              "exact labels. Empty array only when no topics are listed there.",
          },
        },
        required: ["id", "score", "reason", "missing", "facts"],
      },
    },
  },
  required: ["results"],
} as const;

/** One quick-fact topic: a clean display name plus what to actually look for in a posting. */
export type CareAboutTopic = { label: string; looking_for: string };

export const CARE_ABOUT_TOPICS_SCHEMA = {
  type: "object",
  properties: {
    topics: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description:
              "A short, clean display name for this topic, at most 22 characters, in sentence case " +
              "(e.g. 'Salary', 'Years required', 'Work setup', 'Weekend work', 'Travel'). This is a column " +
              "heading, not a sentence: strip conditional phrasing like 'if it says' or 'like how much', drop " +
              "filler words, and never echo the candidate's phrasing back verbatim.",
          },
          looking_for: {
            type: "string",
            description:
              "One clause naming what to extract from a posting for this topic, capturing what the candidate " +
              "actually meant rather than repeating their words (e.g. for 'Work setup': 'whether the role is " +
              "remote, hybrid, or onsite').",
          },
        },
        required: ["label", "looking_for"],
      },
    },
  },
  required: ["topics"],
} as const;

/**
 * Turns the candidate's free-text "what do you care about" into a clean, canonical topic list.
 *
 * The candidate writes conversationally ("remote or hybrid if it says", "like how much percent you
 * have to travel"), and an earlier version fed that straight into the per-posting scoring call,
 * which dutifully echoed it back as the label on every card. Column headings written in someone's
 * off-hand phrasing read as unfinished, and worse, they drifted -- the same topic could come back
 * worded differently on two different postings, since nothing pinned the wording down.
 *
 * Resolving the topics **once, here** rather than per posting fixes both: the model interprets the
 * intent and names it properly, and every posting afterward is handed the identical label list to
 * fill in, so the cards line up. `looking_for` carries the interpreted meaning forward so the
 * extraction step still knows what the candidate was actually asking about.
 */
export async function deriveCareAboutTopics(
  env: LlmEnv,
  provider: Provider,
  careAbout: string,
): Promise<CareAboutTopic[]> {
  const text = careAbout.trim();
  if (!text) return [];
  const prompt = await getManagedPrompt(env, "roles/criteria/extract", { criteria_text: text.slice(0, 2000) });

  const { topics } = await callStructured<{ topics: CareAboutTopic[] }>(
    env,
    provider,
    "fit.criteria",
    prompt,
    CARE_ABOUT_TOPICS_SCHEMA,
    "submit_topics",
    1200,
    "screen",
  );
  return (topics ?? [])
    .map((topic) => ({
      label: String(topic?.label ?? "").trim().slice(0, 40),
      looking_for: String(topic?.looking_for ?? "").trim(),
    }))
    .filter((topic) => topic.label);
}

/**
 * A years-of-experience gap is one of the few requirements precise enough to reason about
 * numerically, so it gets a concrete rule rather than being left to "far beyond" judgment calls
 * -- which in practice let postings needing roughly double the candidate's actual experience
 * through as a "stretch". Calibrated to what actually reads as fine vs. not: needing 5 when you
 * have 3 is a normal reach; needing 7 when you have 3 is a different job level entirely.
 */
// ---------------------------------------------------------------------------
// Geography -- settled in code, not argued in prose
// ---------------------------------------------------------------------------

/**
 * Whether a posting's location is reachable, decided by the same `locationMatches` gate that
 * governs what gets imported in the first place -- and stated to the model as a finding rather
 * than left to it as a judgement call.
 *
 * The model used to be handed the raw location string and the candidate's geography rule and asked
 * to apply one to the other. On a single-location posting that worked. On a posting listing several
 * offices it did not: given `San Francisco, CA | New York City, NY | Seattle, WA` it read the rule
 * as a test of whether the posting was California-*exclusive* rather than California-*reachable*,
 * and marked a San Francisco role as failing a California requirement because New York sat beside
 * it. Five of the strongest postings on the board lost 12-23 points that way.
 *
 * `locationMatches` never had that problem -- it asks whether any acceptable place appears at all,
 * which is the actual question. So the verdict is computed here and passed in already decided. The
 * model is told the answer and told not to re-derive it, which is the same model-proposes /
 * code-owns-the-record split the rest of this file runs on.
 */
export function geographyVerdict(location: string, terms: string[]): string {
  const stated = String(location ?? "").trim();
  if (!terms.length) return "No location constraint stated -- do not score geography at all.";
  if (!stated) return "The posting states no location. Do not deduct for geography on an unstated location.";
  if (!locationMatches(stated, terms)) {
    return "OUTSIDE the candidate's stated area. This is a hard disqualifier -- score it accordingly.";
  }
  return (
    "ACCEPTABLE -- already checked against the candidate's stated area and it passes. " +
    "Treat this as settled fact and do not re-derive it: a posting that lists several offices " +
    "qualifies as soon as ONE of them is reachable, and the others are irrelevant. Do not deduct " +
    "any points for geography, and do not list location, relocation, or onsite presence as a gap."
  );
}

/** Words that only ever appear in a gap that is about *where* the job is. */
const GEOGRAPHY_GAP = /\b(relocat\w*|onsite|on-site|on site|hybrid|in-office|in office|based in|located in|location|commut\w*|geograph\w*|residen\w*)\b/i;

/**
 * Removes location gaps from a posting whose geography already passed the code gate.
 *
 * The prompt says not to raise one; this makes it true regardless. A gap the candidate reads as
 * "you cannot take this job, it is in the wrong place" is uniquely costly when it is wrong -- it
 * argues them out of a posting they are in fact eligible for -- so it is worth removing
 * deterministically rather than trusting an instruction to hold every time.
 *
 * Deliberately narrow: it drops an entry only when a geography word appears AND the code gate
 * already said yes. Everything else survives untouched, including a genuine gap that happens to
 * mention a place ("no experience with EU data residency" keeps its meaning elsewhere in `missing`
 * only if it does not match -- and that is the intended trade: a rare over-drop of one advisory
 * line beats a wrong location rejection on a good posting).
 */
export function dropSettledGeographyGaps(missing: string[], geographyAcceptable: boolean): string[] {
  if (!geographyAcceptable) return missing;
  return missing.filter((entry) => !GEOGRAPHY_GAP.test(String(entry ?? "")));
}

async function fitPrompt(
  env: LlmEnv,
  profileJson: string,
  desiredRoles: string,
  disqualifiers: string[],
  customPreferences: string,
  careAboutTopics: CareAboutTopic[],
  jobs: JobToAssess[],
  locationTerms: string[],
): Promise<import("./langfuse").ManagedPrompt> {
  const customPreferencesSection = customPreferences
    ? [
        "The candidate wrote these matching preferences themselves, in their own words. Enforce them as",
        "binding rules with the same weight as a stated hard requirement above -- if a posting clearly",
        "violates one, that is a hard disqualifier regardless of how strong the rest of the overlap is:",
        customPreferences,
        "",
      ].join("\n")
    : "";
  const quickFacts = careAboutTopics.length
    ? [
        "QUICK FACTS TO REPORT: fill in `facts` with exactly one entry per topic below, in this order,",
        "copying each `label` verbatim -- these are fixed column headings shown next to every posting, so",
        "rewording one makes the same topic look like a different one from posting to posting. For each,",
        "read the posting for what's described and give the value it states, or exactly 'Not specified'.",
        "This is informational only and must NOT affect `score` -- a topic here is something the candidate",
        "wants to see without opening the posting, not a requirement the posting has to meet:",
        ...careAboutTopics.map((topic) => `- ${topic.label} -- ${topic.looking_for}`),
        "",
      ].join("\n")
    : "";
  const disqualifierSection = disqualifiers.length
    ? [
        "The candidate has previously confirmed these were NOT a fit, and why -- weigh a posting",
        "with a similar stated requirement accordingly:",
        ...disqualifiers.map((d) => `- ${d}`),
        "",
      ].join("\n")
    : "";
  const targetRoles = desiredRoles
    ? [
        "TARGET ROLES -- the candidate may be open to more than one genuinely different kind of role, listed",
        "below. A posting only has to be a strong match for ONE of them to be on-target; it is not a mismatch",
        "just because it doesn't also touch the others, and you should not expect or require a single posting",
        "to combine several of them at once:",
        desiredRoles,
        "",
      ].join("\n")
    : "";
  const postings = JSON.stringify(
    jobs.map((j) => ({
      id: j.id,
      title: j.title,
      company: j.company,
      location: j.location,
      // Decided by code before the model ever sees the posting -- see geographyVerdict. It rides
      // inside the postings payload rather than as its own prompt variable so it reaches the model
      // whatever template version Langfuse is currently serving; a new {{variable}} an older
      // published prompt does not mention would compile away to nothing, silently.
      geography: geographyVerdict(j.location, locationTerms),
      // Matches the storage cap (src/index.ts) and the scrape cap (DESCRIPTION_CAP in
      // companies.ts) -- compensation, remote/onsite, hours, and travel facts routinely sit at
      // the very end of a real posting, past where a tighter slice here used to cut them off
      // even when the fuller text was already stored.
      description: j.description.slice(0, 8000),
    })),
  );
  return getManagedPrompt(env, "jobs/fit", {
    current_year: String(new Date().getUTCFullYear()),
    custom_preferences: customPreferencesSection,
    quick_facts: quickFacts,
    disqualifiers: disqualifierSection,
    target_roles: targetRoles,
    candidate_profile: profileJson,
    postings,
  });
}

/**
 * Rebuilds a posting's facts from the canonical topic list, taking only the *values* from the model.
 *
 * Same split the rest of this file runs on: the model proposes, code owns the stored record. The
 * prompt asks for labels verbatim, but a label is a fixed column heading shown against every
 * posting, and one reworded label makes the same topic read as a different one two cards later.
 * Pinning labels here means that can't happen regardless of what comes back. Values are matched by
 * label first, then by position, so a reworded label still keeps its value instead of dropping it.
 */
function alignFactsToTopics(
  topics: CareAboutTopic[],
  returned: { label?: string; value?: string }[] | undefined,
): { label: string; value: string }[] {
  if (!topics.length) return [];
  const facts = returned ?? [];
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const byLabel = new Map<string, string>();
  for (const fact of facts) {
    const key = normalize(String(fact?.label ?? ""));
    if (key && !byLabel.has(key)) byLabel.set(key, String(fact?.value ?? "").trim());
  }
  return topics.map((topic, index) => ({
    label: topic.label,
    value: byLabel.get(normalize(topic.label)) || String(facts[index]?.value ?? "").trim() || "Not specified",
  }));
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
  careAboutTopics: CareAboutTopic[],
  jobs: JobToAssess[],
  // Defaults to unconstrained so an existing caller behaves exactly as it did: with no terms,
  // geographyVerdict tells the model there is no location constraint to score.
  locationTerms: string[] = [],
): Promise<FitResult[]> {
  if (!jobs.length) return [];
  const { results } = await callStructured<{ results: FitResult[] }>(
    env,
    provider,
    "fit.assess",
    await fitPrompt(env, profileJson, desiredRoles, disqualifiers, customPreferences, careAboutTopics, jobs, locationTerms),
    FIT_BATCH_SCHEMA,
    "submit_fit_assessment",
    // Bumped alongside the richer per-posting schema (up to 8 candidate-defined facts per posting) --
    // the previous cap was sized for score/reason/missing plus three fixed fields and would risk
    // truncating a full 8-item batch now that the fact count is candidate-controlled.
    7000,
  );
  const byId = new Map(results.map((r) => [r.id, r]));
  return jobs.map((job) => {
    const found = byId.get(job.id);
    if (!found) {
      return { id: job.id, score: 50, reason: "Not individually assessed.", missing: [], facts: [] };
    }
    const score = Number.isFinite(found.score) ? Math.max(0, Math.min(100, Math.round(found.score))) : 50;
    return {
      id: job.id,
      score,
      reason: found.reason ?? "",
      missing: dropSettledGeographyGaps(
        found.missing ?? [],
        !locationTerms.length || locationMatches(job.location, locationTerms),
      ),
      facts: alignFactsToTopics(careAboutTopics, found.facts),
    };
  });
}

// ---------------------------------------------------------------------------
// Tier 1 -- cheap bulk screen
// ---------------------------------------------------------------------------

export type ScreenResult = { id: string; keep: boolean; note: string };

export const SCREEN_BATCH_SCHEMA = {
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
  const prompt = await getManagedPrompt(
    env,
    "jobs/prescreen",
    {
      disqualifiers: disqualifiers.length
        ? `The candidate has already rejected roles for these reasons:\n${disqualifiers.map((d) => `- ${d}`).join("\n")}\n`
        : "",
      target_roles: desiredRoles ? `WANTS (any ONE of the following, not all at once): ${desiredRoles.slice(0, 600)}\n` : "",
      candidate_profile: matchProfile,
      postings: JSON.stringify(jobs.map((j) => ({ id: j.id, title: j.title, location: j.location }))),
    },
    JOBS_PRESCREEN_PROMPT,
  );

  const { results } = await callStructured<{ results: ScreenResult[] }>(
    env,
    provider,
    "fit.screen",
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

// ---------------------------------------------------------------------------
// Assessment ordering
// ---------------------------------------------------------------------------

/** Title fragments naming a level rather than a skill bar -- assessed last, never dropped here. */
const SENIORITY_MARKERS = [
  "staff", "principal", "director", "head of", "vice president",
  "senior manager", "distinguished", "fellow",
];

/**
 * The "Title terms:" lines the desired-roles document lists under each target lane, flattened and
 * de-duplicated. Parsed out of the profile rather than hand-maintained here, so adding a lane to
 * the candidate's roles automatically teaches this queue what that lane's titles look like.
 */
export function titleTermsFromRoles(desiredRoles: string): string[] {
  const out = new Set<string>();
  for (const line of String(desiredRoles ?? "").split("\n")) {
    const match = line.match(/^\s*title terms\s*:\s*(.+)$/i);
    if (!match) continue;
    for (const term of match[1].split(",")) {
      const cleaned = term.trim().toLowerCase();
      if (cleaned.length > 2) out.add(cleaned);
    }
  }
  return Array.from(out);
}

/**
 * An ORDER BY fragment, and its bindings, that puts the most plausible postings at the front of
 * the assessment queue.
 *
 * The assess tier is budget-capped, so whatever it reaches first is what actually gets scored.
 * In board order that meant paying reasoning-model rates to rate "Senior Software Engineer,
 * Database Engine Internals" while the Forward Deployed Engineer and Solutions Architect roles
 * sat unscored behind it and the budget ran out. Sorting by "does this title name a lane the
 * candidate actually wants" spends the identical budget on the postings most likely to survive.
 *
 * Nothing is filtered out here -- a seniority-marked title still gets assessed, just last, so the
 * model keeps making the accept/reject call rather than a LIKE pattern making it silently.
 */
export function assessPriorityOrder(titleTerms: string[]): { sql: string; binds: string[] } {
  const binds: string[] = [];

  const onTarget = titleTerms.length ? titleTerms.map(() => "lower(title) LIKE ?").join(" OR ") : "0";
  for (const term of titleTerms) binds.push(`%${term}%`);

  const senior = SENIORITY_MARKERS.map(() => "lower(title) LIKE ?").join(" OR ");
  for (const marker of SENIORITY_MARKERS) binds.push(`%${marker}%`);

  return {
    sql:
      `ORDER BY (CASE WHEN ${onTarget} THEN 0 ELSE 1 END), ` +
      `(CASE WHEN ${senior} THEN 1 ELSE 0 END), created_at ASC`,
    binds,
  };
}

export const SCREEN_BATCH_SIZE = 60;
export const FIT_BATCH_SIZE = 8;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
