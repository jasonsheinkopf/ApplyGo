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

/** Add one small entry point to the existing Settings > Devices UI without editing index.ts. */
export function injectAgentSettingsLink(html: string): string {
  if (html.includes('id="agent-access-link"')) return html;
  const marker = '<div id="devices-list"><p class="empty">Loading…</p></div>';
  if (!html.includes(marker)) return html;
  const addition = `${marker}\n        <p class="hint" style="margin-top:0.8rem">ChatGPT or another trusted agent can use the same ApplyGo data through a separately revocable Agent API credential. <a id="agent-access-link" href="/agent">Manage agent access</a>.</p>`;
  return html.replace(marker, addition);
}
