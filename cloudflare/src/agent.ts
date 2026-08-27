import type { CompanyCounts } from "./pipeline.ts";

export const ONBOARDING_TOPICS = [
  "resume",
  "career_direction",
  "locations",
  "dealbreakers",
  "priorities",
  "extra_evidence",
] as const;

export type OnboardingTopic = (typeof ONBOARDING_TOPICS)[number];

export type OnboardingConfirmed = Record<OnboardingTopic, boolean>;

export type AgentProfileFacts = {
  documentCount: number;
  careerPreferenceCount: number;
  noteCount: number;
  desiredLocations: string;
  dealbreakers: string;
  careAbout: string;
};

export type AgentOnboardingQuestion = {
  topic: OnboardingTopic;
  prompt: string;
  why: string;
};

export function emptyConfirmed(): OnboardingConfirmed {
  return {
    resume: false,
    career_direction: false,
    locations: false,
    dealbreakers: false,
    priorities: false,
    extra_evidence: false,
  };
}

export function inferConfirmedFromExisting(facts: AgentProfileFacts): OnboardingConfirmed {
  return {
    resume: facts.documentCount > 0,
    career_direction: facts.careerPreferenceCount > 0,
    locations: Boolean(facts.desiredLocations.trim()),
    dealbreakers: Boolean(facts.dealbreakers.trim()),
    priorities: Boolean(facts.careAbout.trim()),
    extra_evidence: facts.noteCount > 0,
  };
}

const QUESTION_COPY: Record<OnboardingTopic, Omit<AgentOnboardingQuestion, "topic">> = {
  resume: {
    prompt: "Give me your current resume or CV. If you have more than one, start with the one that best represents your recent experience.",
    why: "ApplyGo uses source documents as career evidence and builds the structured profile from them.",
  },
  career_direction: {
    prompt: "What kinds of jobs are you actually trying to get? Tell me the roles, work you want to do, and anything you want more or less of in the next job.",
    why: "Your own description of the work you want is stored as Career preferences and later used to derive searchable role families.",
  },
  locations: {
    prompt: "Where are you willing to work? Include remote, hybrid, onsite, relocation, commute limits, or specific regions if any of those matter.",
    why: "Location is a hard discovery filter, so the agent should not guess it from a resume or current address.",
  },
  dealbreakers: {
    prompt: "What should I automatically reject? Include hard constraints such as compensation, seniority, years required, travel, industry, employment type, work authorization, or anything else that makes a job not worth considering. If you have none, say none.",
    why: "Dealbreakers are binding rules during detailed job scoring.",
  },
  priorities: {
    prompt: "What facts do you want me to pay attention to when comparing jobs? For example compensation, remote policy, required experience, hours, team type, technical stack, or company size.",
    why: "ApplyGo surfaces these as decision facts even when they are not hard filters.",
  },
  extra_evidence: {
    prompt: "What important career evidence is missing from your resume? Think about projects, accomplishments, numbers, responsibilities, research, side projects, teaching, leadership, or technical work. If the resume is complete enough to start, say so.",
    why: "These facts become reusable evidence instead of being rediscovered separately for every application.",
  },
};

export function buildOnboardingQuestions(confirmed: OnboardingConfirmed): AgentOnboardingQuestion[] {
  return ONBOARDING_TOPICS.filter((topic) => !confirmed[topic]).map((topic) => ({
    topic,
    ...QUESTION_COPY[topic],
  }));
}

export type PreferencePatch = {
  desired_locations?: string;
  dealbreakers?: string;
  care_about?: string;
};

/**
 * Merge only user-authored preference fields. Derived fields are invalidated whenever one of their
 * inputs changes so the UI never presents an old role analysis as if it had considered new rules.
 */
export function mergeAgentPreferences(
  existing: Record<string, unknown>,
  patch: PreferencePatch,
): { preferences: Record<string, unknown>; changed: (keyof PreferencePatch)[] } {
  const preferences = { ...existing };
  const changed: (keyof PreferencePatch)[] = [];

  for (const key of ["desired_locations", "dealbreakers", "care_about"] as const) {
    if (patch[key] === undefined) continue;
    const next = String(patch[key] ?? "").trim();
    const previous = typeof preferences[key] === "string" ? String(preferences[key]) : "";
    if (next !== previous) changed.push(key);
    preferences[key] = next;
  }

  if (changed.includes("care_about")) delete preferences.care_about_topics;
  if (changed.length) {
    delete preferences.role_analysis;
    delete preferences.desired_roles;
  }

  return { preferences, changed };
}

export function safeTextDocumentName(raw: string): string {
  let name = String(raw || "resume-from-chat.txt")
    .replace(/[\\/\0-\x1f\x7f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  if (!name) name = "resume-from-chat.txt";
  if (!/\.txt$/i.test(name)) name = name.replace(/\.[a-z0-9]{1,8}$/i, "") + ".txt";
  return name;
}

/**
 * Fills in the fixed CompanyCounts shape pipeline.ts's companyFunnel expects from the raw
 * key/count map GET /companies already returns as `company_pipeline`. Reused rather than
 * recomputed -- companiesPipelineCounts in index.ts is the one place that SQL is allowed to live,
 * per the same "one source of truth" rule pipeline.ts documents for itself.
 */
export function toCompanyCounts(raw: Record<string, number>): CompanyCounts {
  return {
    identity_pending: raw.identity_pending ?? 0,
    identity_verified: raw.identity_verified ?? 0,
    identity_ambiguous: raw.identity_ambiguous ?? 0,
    identity_unresolved: raw.identity_unresolved ?? 0,
    identity_not_a_company: raw.identity_not_a_company ?? 0,
    identity_dismissed: raw.identity_dismissed ?? 0,
    source_pending: raw.source_pending ?? 0,
    source_supported: raw.source_supported ?? 0,
    source_unsupported_ats: raw.source_unsupported_ats ?? 0,
    source_careers_only: raw.source_careers_only ?? 0,
    source_no_board: raw.source_no_board ?? 0,
    source_board_unreachable: raw.source_board_unreachable ?? 0,
    discovery_postings: raw.discovery_postings ?? 0,
    total: raw.total ?? 0,
  };
}

function safeJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export type ShortlistJob = {
  id: string;
  title: string;
  company: string;
  location: string;
  fit_score: number | null;
  fit_reason: string;
  missing: string[];
  url: string;
};

/**
 * The agent-facing shortlist: strong/possible jobs at or above minScore, best first, with the
 * rationale that already lives on the row (fit_reason, fit_missing_json) rather than a bare
 * number -- a raw score without why it was given is not something a candidate (or an agent
 * speaking for one) can act on.
 */
export function shapeShortlist(jobs: Record<string, unknown>[], minScore: number, limit: number): ShortlistJob[] {
  return jobs
    .filter((job) => {
      const status = String(job.fit_status ?? "");
      return (status === "strong" || status === "possible") && Number(job.fit_score ?? -1) >= minScore;
    })
    .sort((a, b) => Number(b.fit_score ?? 0) - Number(a.fit_score ?? 0))
    .slice(0, limit)
    .map((job) => ({
      id: String(job.id ?? ""),
      title: String(job.title ?? ""),
      company: String(job.company ?? ""),
      location: String(job.location ?? ""),
      fit_score: job.fit_score === null || job.fit_score === undefined ? null : Number(job.fit_score),
      fit_reason: String(job.fit_reason ?? ""),
      missing: safeJsonArray(job.fit_missing_json),
      url: String(job.source_url ?? ""),
    }));
}

/** Jobs whose row was created at or after a captured watermark -- used to report what a scan actually surfaced. */
export function newlyDiscoveredJobs(jobs: Record<string, unknown>[], sinceIso: string): Record<string, unknown>[] {
  return jobs.filter((job) => String(job.created_at ?? "") >= sinceIso);
}

export type LegacyEvent = Record<string, unknown>;

/**
 * Collapses a legacy route's response into one JSON-safe summary regardless of whether it replied
 * with a single JSON object or an NDJSON progress stream (several of the pipeline routes this
 * gateway wraps -- /companies/scan, /jobs/process -- report progress that way for the browser UI's
 * live view). An MCP tool call gets one result, not a stream, so this is what makes those routes
 * usable as agent tools without teaching every caller the NDJSON shape.
 */
export function summarizeLegacyBody(bodyText: string): Record<string, unknown> {
  const lines = bodyText.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) {
    try {
      return JSON.parse(bodyText || "{}") as Record<string, unknown>;
    } catch {
      return { raw: bodyText.slice(0, 2000) };
    }
  }
  const events: LegacyEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as LegacyEvent);
    } catch {
      // One malformed progress line must not lose the rest of a real stream.
    }
  }
  const eventCounts: Record<string, number> = {};
  const errors: LegacyEvent[] = [];
  for (const event of events) {
    const key = [event.type, event.stage, event.phase].filter(Boolean).join(".") || "event";
    eventCounts[key] = (eventCounts[key] ?? 0) + 1;
    if (event.phase === "failed" || event.type === "error") errors.push(event);
  }
  return {
    event_counts: eventCounts,
    errors: errors.slice(0, 10),
    final_event: events[events.length - 1] ?? {},
    total_events: events.length,
  };
}

/** Add one small entry point to the existing Settings > Devices UI without editing index.ts. */
export function injectAgentSettingsLink(html: string): string {
  if (html.includes('id="agent-access-link"')) return html;
  const marker = '<div id="devices-list"><p class="empty">Loading…</p></div>';
  if (!html.includes(marker)) return html;
  const addition = `${marker}\n        <p class="hint" style="margin-top:0.8rem">ChatGPT or another trusted agent can use the same ApplyGo data through a separately revocable Agent API credential. <a id="agent-access-link" href="/agent">Manage agent access</a>.</p>`;
  return html.replace(marker, addition);
}
