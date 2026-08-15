/**
 * The canonical career-evidence record: who this candidate is, professionally, as structured data.
 *
 * This replaces the old five-field `StructuredProfile` (headline/narrative_summary/education/
 * experience/skills) and the "master resume" as the system's source of truth. The distinction that
 * drives the whole design:
 *
 *   - A **profile** is evidence. It holds everything the candidate can prove, in the context where
 *     it happened, with no regard for length, ATS keywords, or any one job.
 *   - A **resume** is presentation. It selects, orders and rewrites a subset of that evidence for
 *     one target.
 *
 * The old schema conflated the two -- it was shaped like a resume, so anything a resume wouldn't
 * show (mentoring, stakeholder work, project outcomes, per-role metrics) had nowhere to live and
 * was discarded at generation time. That loss showed up two stages downstream, in career analysis
 * that could only echo job titles the candidate had already typed, because the evidence needed to
 * infer a non-obvious career path had been thrown away before it ever got there.
 *
 * **Provenance is the organizing rule.** Information stays attached to the context that produced
 * it: mentoring done at Company A is a field on the Company A work-experience record, not a
 * free-floating "mentoring" skill; an award won for a university project hangs off that project.
 * Flat aggregate sections (`technical_skills`, `career_signals`) therefore carry `evidence[]`
 * pointing back at where the claim comes from, rather than standing alone as bare assertions.
 */

/** Bumped whenever the shape below changes incompatibly, and stored alongside every generated
 * profile so a later migration can tell what it is looking at instead of guessing from field
 * presence. `1` is reserved for the legacy headline/education/experience/skills shape. */
export const CAREER_PROFILE_SCHEMA_VERSION = 2;

export type ProfileLink = { label: string; url: string };

export type ProfileProject = {
  name: string;
  description: string;
  problem_or_purpose: string;
  work_performed: string[];
  technologies_and_methods: string[];
  outcomes: string[];
  metrics: string[];
  skills_demonstrated: string[];
};

export type ProfileAchievement = { description: string; metrics: string[] };

export type WorkExperience = {
  organization: string;
  title: string;
  employment_type: string;
  location: string;
  start_date: string;
  end_date: string;
  current: boolean;
  description: string;
  responsibilities: string[];
  projects: ProfileProject[];
  achievements: ProfileAchievement[];
  leadership_and_management: string[];
  mentoring_and_teaching: string[];
  stakeholder_and_client_work: string[];
  communication_and_documentation: string[];
  technologies_and_methods: string[];
  skills_demonstrated: string[];
};

export type EducationProject = {
  name: string;
  description: string;
  work_performed: string[];
  technologies_and_methods: string[];
  outcomes: string[];
  awards_and_honors: string[];
  skills_demonstrated: string[];
};

export type EducationResearch = {
  topic: string;
  description: string;
  contributions: string[];
  outcomes: string[];
};

export type Education = {
  institution: string;
  degree: string;
  field_of_study: string;
  specialization: string;
  location: string;
  start_date: string;
  end_date: string;
  coursework: string[];
  projects: EducationProject[];
  research: EducationResearch[];
  activities: string[];
  awards_and_honors: string[];
};

export type IndependentProject = {
  name: string;
  project_type: string;
  dates: string;
  description: string;
  problem_or_purpose: string;
  work_performed: string[];
  technologies_and_methods: string[];
  outcomes: string[];
  metrics: string[];
  links: ProfileLink[];
  skills_demonstrated: string[];
};

export type ResearchPublication = {
  title: string;
  type: string;
  venue: string;
  date: string;
  authorship_role: string;
  associated_organization: string;
  topic: string;
  contributions: string[];
  recognition: string[];
  links: ProfileLink[];
};

/** The shape every aggregate/rollup section shares: a claim plus where it came from. */
export type EvidencedItem = { name: string; evidence: string[] };

export type CareerProfile = {
  schema_version: number;
  identity: {
    name: string;
    email: string;
    phone: string;
    location: string;
    citizenship_or_work_authorization: string[];
    links: ProfileLink[];
  };
  career_summary: { headline: string; narrative_summary: string };
  work_experience: WorkExperience[];
  education: Education[];
  independent_projects: IndependentProject[];
  research_and_publications: ResearchPublication[];
  technical_skills: EvidencedItem[];
  tools_and_technologies: EvidencedItem[];
  professional_skills: EvidencedItem[];
  domain_knowledge: EvidencedItem[];
  certifications_and_training: string[];
  independent_awards_and_honors: string[];
  community_outreach_and_volunteer: string[];
  professional_memberships: string[];
  languages: string[];
  career_signals: EvidencedItem[];
  evidence_gaps: {
    topic: string;
    missing_information: string;
    why_it_matters: string;
    suggested_question: string;
  }[];
  other: { category: string; description: string }[];
};

// ---------------------------------------------------------------------------
// Structured-output JSON Schema
// ---------------------------------------------------------------------------

const strArray = (description: string) => ({ type: "array", items: { type: "string" }, description });

const LINKS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: { label: { type: "string" }, url: { type: "string" } },
    required: ["label", "url"],
  },
};

/**
 * The schema the model must fill. Deliberately shallow on `required`: only the two career_summary
 * fields are mandatory, because every other section is legitimately empty for some real candidate
 * and demanding them is what produces invented filler. `normalizeCareerProfile` below supplies
 * every missing array/scalar afterwards, so code downstream can index freely without guarding.
 */
export const CAREER_PROFILE_SCHEMA = {
  type: "object",
  properties: {
    identity: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        location: { type: "string" },
        citizenship_or_work_authorization: strArray("Only if the source material states it."),
        links: LINKS_SCHEMA,
      },
    },
    career_summary: {
      type: "object",
      properties: {
        headline: { type: "string", description: "One line naming what this person is, professionally." },
        narrative_summary: {
          type: "string",
          description:
            "A few sentences describing their actual background and demonstrated capability. Factual, " +
            "not aspirational, and not written as a resume objective.",
        },
      },
      required: ["headline", "narrative_summary"],
    },
    work_experience: {
      type: "array",
      description: "Every paid or professional role the source material supports, most recent first.",
      items: {
        type: "object",
        properties: {
          organization: { type: "string" },
          title: { type: "string" },
          employment_type: { type: "string", description: "e.g. Full-time, Contract, Internship. Empty if unstated." },
          location: { type: "string" },
          start_date: { type: "string" },
          end_date: { type: "string", description: "Empty when this is the current role." },
          current: { type: "boolean" },
          description: { type: "string", description: "What the role actually was." },
          responsibilities: strArray("Ongoing duties -- what they were responsible for, not what they achieved."),
          projects: {
            type: "array",
            description: "Distinct pieces of work done in this role. This is where most real evidence lives.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                problem_or_purpose: { type: "string", description: "Why this work existed." },
                work_performed: strArray("What this person specifically did."),
                technologies_and_methods: strArray("Named tools, languages, frameworks, techniques."),
                outcomes: strArray("What resulted."),
                metrics: strArray("Quantified results, copied exactly as stated. Never estimate or round."),
                skills_demonstrated: strArray("Capabilities this work proves."),
              },
              required: ["name"],
            },
          },
          achievements: {
            type: "array",
            description: "Discrete accomplishments, as distinct from ongoing responsibilities.",
            items: {
              type: "object",
              properties: {
                description: { type: "string" },
                metrics: strArray("Quantified results, copied exactly as stated."),
              },
              required: ["description"],
            },
          },
          leadership_and_management: strArray("Leading people, owning outcomes, running initiatives."),
          mentoring_and_teaching: strArray("Teaching, mentoring, onboarding, training others."),
          stakeholder_and_client_work: strArray("Working with customers, clients, or cross-functional partners."),
          communication_and_documentation: strArray("Writing, presenting, documenting, explaining."),
          technologies_and_methods: strArray("Role-level tools and methods not tied to one project."),
          skills_demonstrated: strArray("Role-level capabilities this position proves."),
        },
        required: ["organization", "title"],
      },
    },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          institution: { type: "string" },
          degree: { type: "string" },
          field_of_study: { type: "string" },
          specialization: { type: "string" },
          location: { type: "string" },
          start_date: { type: "string" },
          end_date: { type: "string" },
          coursework: strArray("Only courses the source material actually names."),
          projects: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                work_performed: strArray(""),
                technologies_and_methods: strArray(""),
                outcomes: strArray(""),
                awards_and_honors: strArray("Awards won for this specific project."),
                skills_demonstrated: strArray(""),
              },
              required: ["name"],
            },
          },
          research: {
            type: "array",
            items: {
              type: "object",
              properties: {
                topic: { type: "string" },
                description: { type: "string" },
                contributions: strArray(""),
                outcomes: strArray(""),
              },
              required: ["topic"],
            },
          },
          activities: strArray("Clubs, societies, roles held while studying."),
          awards_and_honors: strArray("Awards tied to this education, not to one project."),
        },
        required: ["institution"],
      },
    },
    independent_projects: {
      type: "array",
      description: "Personal, open-source, freelance or side work done outside a job or degree.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          project_type: { type: "string" },
          dates: { type: "string" },
          description: { type: "string" },
          problem_or_purpose: { type: "string" },
          work_performed: strArray(""),
          technologies_and_methods: strArray(""),
          outcomes: strArray(""),
          metrics: strArray("Copied exactly as stated."),
          links: LINKS_SCHEMA,
          skills_demonstrated: strArray(""),
        },
        required: ["name"],
      },
    },
    research_and_publications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          type: { type: "string", description: "e.g. Paper, Thesis, Talk, Patent, Blog series." },
          venue: { type: "string" },
          date: { type: "string" },
          authorship_role: { type: "string", description: "e.g. First author, Co-author, Sole author." },
          associated_organization: { type: "string" },
          topic: { type: "string" },
          contributions: strArray(""),
          recognition: strArray(""),
          links: LINKS_SCHEMA,
        },
        required: ["title"],
      },
    },
    technical_skills: {
      type: "array",
      description:
        "Rollup of demonstrable technical capability. Every entry must cite where it is demonstrated -- " +
        "a skill with no evidence anywhere in the record does not belong here.",
      items: {
        type: "object",
        properties: {
          skill: { type: "string" },
          evidence: strArray("Short pointers to where this is demonstrated, e.g. 'Retrieval pipeline at Acme'."),
        },
        required: ["skill"],
      },
    },
    tools_and_technologies: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, evidence: strArray("") },
        required: ["name"],
      },
    },
    professional_skills: {
      type: "array",
      description: "Non-technical capability: communication, leadership, teaching, client work.",
      items: {
        type: "object",
        properties: { skill: { type: "string" }, evidence: strArray("") },
        required: ["skill"],
      },
    },
    domain_knowledge: {
      type: "array",
      description: "Industries and subject areas they have actually worked in.",
      items: {
        type: "object",
        properties: { domain: { type: "string" }, evidence: strArray("") },
        required: ["domain"],
      },
    },
    certifications_and_training: strArray("Formal certifications and completed training programmes."),
    independent_awards_and_honors: strArray("Awards not tied to a specific job, degree or project above."),
    community_outreach_and_volunteer: strArray(""),
    professional_memberships: strArray(""),
    languages: strArray("Human languages, with proficiency when stated."),
    career_signals: {
      type: "array",
      description:
        "Durable patterns visible across the whole record that a career analysis would want -- e.g. " +
        "'consistently bridges technical and non-technical audiences'. Each must cite its evidence. " +
        "Observations only: no career advice or role recommendations at this stage.",
      items: {
        type: "object",
        properties: { signal: { type: "string" }, evidence: strArray("") },
        required: ["signal"],
      },
    },
    evidence_gaps: {
      type: "array",
      description:
        "Information that is missing or unclear and would materially change the picture if known. " +
        "Name the gap; never fill it in with a guess.",
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          missing_information: { type: "string" },
          why_it_matters: { type: "string" },
          suggested_question: { type: "string", description: "A question to ask the candidate." },
        },
        required: ["topic", "missing_information"],
      },
    },
    other: {
      type: "array",
      description: "Anything supported by the source material that genuinely fits nowhere above.",
      items: {
        type: "object",
        properties: { category: { type: "string" }, description: { type: "string" } },
        required: ["category", "description"],
      },
    },
  },
  required: ["career_summary"],
} as const;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const bool = (value: unknown): boolean => value === true;

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = str(item);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function objList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Record<string, unknown>[]) : [];
}

function linkList(value: unknown): ProfileLink[] {
  return objList(value)
    .map((l) => ({ label: str(l.label), url: str(l.url) }))
    .filter((l) => l.url || l.label);
}

/** Aggregate sections all normalize the same way; only the name key differs between them. */
function evidencedList(value: unknown, key: string): EvidencedItem[] {
  const seen = new Set<string>();
  const out: EvidencedItem[] = [];
  for (const item of objList(value)) {
    const name = str(item[key]);
    if (!name) continue;
    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ name, evidence: strList(item.evidence) });
  }
  return out;
}

function normalizeProject(raw: Record<string, unknown>): ProfileProject {
  return {
    name: str(raw.name),
    description: str(raw.description),
    problem_or_purpose: str(raw.problem_or_purpose),
    work_performed: strList(raw.work_performed),
    technologies_and_methods: strList(raw.technologies_and_methods),
    outcomes: strList(raw.outcomes),
    metrics: strList(raw.metrics),
    skills_demonstrated: strList(raw.skills_demonstrated),
  };
}

function normalizeWorkExperience(raw: Record<string, unknown>): WorkExperience {
  const endDate = str(raw.end_date);
  return {
    organization: str(raw.organization),
    title: str(raw.title),
    employment_type: str(raw.employment_type),
    location: str(raw.location),
    start_date: str(raw.start_date),
    end_date: endDate,
    // A model that writes "Present" into end_date and omits `current` is stating the same fact
    // twice in different places; treat either spelling as current so downstream ordering agrees.
    current: bool(raw.current) || /^(present|current|now|ongoing)$/i.test(endDate),
    description: str(raw.description),
    responsibilities: strList(raw.responsibilities),
    projects: objList(raw.projects).map(normalizeProject).filter((p) => p.name || p.description),
    achievements: objList(raw.achievements)
      .map((a) => ({ description: str(a.description), metrics: strList(a.metrics) }))
      .filter((a) => a.description),
    leadership_and_management: strList(raw.leadership_and_management),
    mentoring_and_teaching: strList(raw.mentoring_and_teaching),
    stakeholder_and_client_work: strList(raw.stakeholder_and_client_work),
    communication_and_documentation: strList(raw.communication_and_documentation),
    technologies_and_methods: strList(raw.technologies_and_methods),
    skills_demonstrated: strList(raw.skills_demonstrated),
  };
}

function normalizeEducation(raw: Record<string, unknown>): Education {
  return {
    institution: str(raw.institution),
    degree: str(raw.degree),
    field_of_study: str(raw.field_of_study),
    specialization: str(raw.specialization),
    location: str(raw.location),
    start_date: str(raw.start_date),
    end_date: str(raw.end_date),
    coursework: strList(raw.coursework),
    projects: objList(raw.projects)
      .map((p) => ({
        name: str(p.name),
        description: str(p.description),
        work_performed: strList(p.work_performed),
        technologies_and_methods: strList(p.technologies_and_methods),
        outcomes: strList(p.outcomes),
        awards_and_honors: strList(p.awards_and_honors),
        skills_demonstrated: strList(p.skills_demonstrated),
      }))
      .filter((p) => p.name || p.description),
    research: objList(raw.research)
      .map((r) => ({
        topic: str(r.topic),
        description: str(r.description),
        contributions: strList(r.contributions),
        outcomes: strList(r.outcomes),
      }))
      .filter((r) => r.topic || r.description),
    activities: strList(raw.activities),
    awards_and_honors: strList(raw.awards_and_honors),
  };
}

/**
 * Turns whatever the model returned into a complete, indexable CareerProfile.
 *
 * Entries with no identifying content are dropped rather than kept as empty shells -- an empty
 * work-experience row is not evidence of a job, it is evidence the model padded the array. Every
 * array is present (possibly empty) and every scalar is a string on the way out, so consumers
 * never need optional chaining against this type.
 */
export function normalizeCareerProfile(raw: unknown): CareerProfile {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const identity = (input.identity ?? {}) as Record<string, unknown>;
  const summary = (input.career_summary ?? {}) as Record<string, unknown>;

  return {
    schema_version: CAREER_PROFILE_SCHEMA_VERSION,
    identity: {
      name: str(identity.name),
      email: str(identity.email),
      phone: str(identity.phone),
      location: str(identity.location),
      citizenship_or_work_authorization: strList(identity.citizenship_or_work_authorization),
      links: linkList(identity.links),
    },
    career_summary: {
      headline: str(summary.headline),
      narrative_summary: str(summary.narrative_summary),
    },
    work_experience: objList(input.work_experience)
      .map(normalizeWorkExperience)
      .filter((e) => e.organization || e.title),
    education: objList(input.education)
      .map(normalizeEducation)
      .filter((e) => e.institution || e.degree),
    independent_projects: objList(input.independent_projects)
      .map((p) => ({
        name: str(p.name),
        project_type: str(p.project_type),
        dates: str(p.dates),
        description: str(p.description),
        problem_or_purpose: str(p.problem_or_purpose),
        work_performed: strList(p.work_performed),
        technologies_and_methods: strList(p.technologies_and_methods),
        outcomes: strList(p.outcomes),
        metrics: strList(p.metrics),
        links: linkList(p.links),
        skills_demonstrated: strList(p.skills_demonstrated),
      }))
      .filter((p) => p.name || p.description),
    research_and_publications: objList(input.research_and_publications)
      .map((r) => ({
        title: str(r.title),
        type: str(r.type),
        venue: str(r.venue),
        date: str(r.date),
        authorship_role: str(r.authorship_role),
        associated_organization: str(r.associated_organization),
        topic: str(r.topic),
        contributions: strList(r.contributions),
        recognition: strList(r.recognition),
        links: linkList(r.links),
      }))
      .filter((r) => r.title),
    technical_skills: evidencedList(input.technical_skills, "skill"),
    tools_and_technologies: evidencedList(input.tools_and_technologies, "name"),
    professional_skills: evidencedList(input.professional_skills, "skill"),
    domain_knowledge: evidencedList(input.domain_knowledge, "domain"),
    certifications_and_training: strList(input.certifications_and_training),
    independent_awards_and_honors: strList(input.independent_awards_and_honors),
    community_outreach_and_volunteer: strList(input.community_outreach_and_volunteer),
    professional_memberships: strList(input.professional_memberships),
    languages: strList(input.languages),
    career_signals: evidencedList(input.career_signals, "signal"),
    evidence_gaps: objList(input.evidence_gaps)
      .map((g) => ({
        topic: str(g.topic),
        missing_information: str(g.missing_information),
        why_it_matters: str(g.why_it_matters),
        suggested_question: str(g.suggested_question),
      }))
      .filter((g) => g.topic || g.missing_information),
    other: objList(input.other)
      .map((o) => ({ category: str(o.category), description: str(o.description) }))
      .filter((o) => o.description),
  };
}

/** True when the record carries any actual evidence, as opposed to being structurally present but
 * empty. Used for "has a profile yet?" decisions, where an all-empty shell must count as "no". */
export function careerProfileHasContent(profile: CareerProfile | null): boolean {
  if (!profile) return false;
  return Boolean(
    profile.career_summary.headline ||
      profile.career_summary.narrative_summary ||
      profile.work_experience.length ||
      profile.education.length ||
      profile.independent_projects.length ||
      profile.research_and_publications.length ||
      profile.technical_skills.length,
  );
}

// ---------------------------------------------------------------------------
// Legacy adaptation
// ---------------------------------------------------------------------------

/** The pre-refactor shape, kept only so stored profiles from before this change still load. */
export type LegacyStructuredProfile = {
  headline?: string;
  narrative_summary?: string;
  education?: { school?: string; degree?: string; field?: string; start_year?: string; end_year?: string }[];
  experience?: { company?: string; title?: string; start?: string; end?: string; highlights?: string[] }[];
  skills?: string[];
};

/**
 * Lifts a legacy profile into the new shape *without inventing structure*.
 *
 * The deliberate restraint here matters. A legacy `highlights[]` is an undifferentiated list of
 * resume bullets -- some responsibilities, some achievements, some project descriptions -- and
 * guessing which is which would write fabricated categorization into the canonical record, exactly
 * the "bad categorization becomes immortal" failure this refactor is meant to end. So highlights
 * land in `responsibilities` (the weakest, most defensible claim) and nothing is promoted into
 * projects, metrics or achievements. The real fix is a regeneration from the source documents,
 * which the Summary tab prompts for; this adapter exists so nothing crashes in the meantime.
 */
export function legacyToCareerProfile(legacy: LegacyStructuredProfile | null): CareerProfile {
  const base = normalizeCareerProfile({});
  if (!legacy) return base;
  return {
    ...base,
    // Marked as legacy-derived rather than as a genuine v2 record, so the UI can say so and a
    // future migration can tell converted data apart from freshly generated data.
    schema_version: 1,
    career_summary: {
      headline: str(legacy.headline),
      narrative_summary: str(legacy.narrative_summary),
    },
    work_experience: (legacy.experience ?? []).map((e) => ({
      ...normalizeWorkExperience({}),
      organization: str(e.company),
      title: str(e.title),
      start_date: str(e.start),
      end_date: str(e.end),
      current: /^(present|current|now)$/i.test(str(e.end)),
      responsibilities: strList(e.highlights),
    })).filter((e) => e.organization || e.title),
    education: (legacy.education ?? []).map((e) => ({
      ...normalizeEducation({}),
      institution: str(e.school),
      degree: str(e.degree),
      field_of_study: str(e.field),
      start_date: str(e.start_year),
      end_date: str(e.end_year),
    })).filter((e) => e.institution || e.degree),
    technical_skills: strList(legacy.skills).map((skill) => ({ name: skill, evidence: [] })),
  };
}

/** Detects which of the two stored shapes a `structured_json` blob holds. */
export function isLegacyProfileShape(parsed: Record<string, unknown>): boolean {
  if (parsed.schema_version === CAREER_PROFILE_SCHEMA_VERSION) return false;
  if (parsed.career_summary || parsed.work_experience) return false;
  return Boolean(parsed.headline || parsed.experience || parsed.education || parsed.skills);
}

/**
 * Reads a stored profile of either generation into the canonical type. Returns null only when
 * there is genuinely nothing stored, so callers can distinguish "no profile yet" from "empty".
 */
export function readCareerProfile(structuredJson: string): CareerProfile | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(structuredJson || "{}");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Object.keys(parsed).length) return null;
  const profile = isLegacyProfileShape(parsed)
    ? legacyToCareerProfile(parsed as LegacyStructuredProfile)
    : normalizeCareerProfile(parsed);
  return careerProfileHasContent(profile) ? profile : null;
}

// ---------------------------------------------------------------------------
// Deterministic renderings
// ---------------------------------------------------------------------------

function section(title: string, body: string[]): string {
  const lines = body.filter(Boolean);
  return lines.length ? `## ${title}\n${lines.join("\n")}` : "";
}

function bullets(label: string, items: string[], indent = "  "): string {
  return items.length ? `${indent}${label}: ${items.join("; ")}` : "";
}

/**
 * A near-lossless plain-text rendering of the whole profile.
 *
 * This is what infrequent, high-value reasoning calls get -- career analysis, deep job-fit
 * assessment, resume composition. The rule behind it: those calls run rarely enough that saving a
 * few thousand tokens is a bad trade against losing the very evidence (projects, mentoring,
 * stakeholder work, metrics) that makes a non-obvious career path discoverable at all. The compact
 * `buildMatchProfile` below is for the opposite case, where hundreds of calls make size the
 * dominant cost.
 *
 * Rendered as headed plain text rather than raw JSON because models read prose structure more
 * reliably than deep brace nesting, and because it keeps the prompt legible in a Langfuse trace.
 */
export function renderCareerProfile(profile: CareerProfile): string {
  const parts: string[] = [];
  const id = profile.identity;

  parts.push(
    section("Identity", [
      id.name ? `Name: ${id.name}` : "",
      id.location ? `Location: ${id.location}` : "",
      bullets("Work authorization", id.citizenship_or_work_authorization, ""),
      id.links.length ? `Links: ${id.links.map((l) => `${l.label} ${l.url}`.trim()).join("; ")}` : "",
    ]),
  );

  parts.push(
    section("Career summary", [
      profile.career_summary.headline,
      profile.career_summary.narrative_summary,
    ]),
  );

  parts.push(
    section(
      "Work experience",
      profile.work_experience.map((role) => {
        const span = [role.start_date, role.current ? "Present" : role.end_date].filter(Boolean).join(" – ");
        const head = `- ${role.title || "Role"} at ${role.organization || "Unknown"}${span ? ` (${span})` : ""}` +
          `${role.location ? `, ${role.location}` : ""}${role.employment_type ? ` [${role.employment_type}]` : ""}`;
        const lines = [
          head,
          role.description ? `  ${role.description}` : "",
          bullets("Responsibilities", role.responsibilities),
          bullets("Leadership", role.leadership_and_management),
          bullets("Mentoring/teaching", role.mentoring_and_teaching),
          bullets("Stakeholder/client work", role.stakeholder_and_client_work),
          bullets("Communication/documentation", role.communication_and_documentation),
          bullets("Technologies", role.technologies_and_methods),
          bullets("Skills demonstrated", role.skills_demonstrated),
        ];
        for (const p of role.projects) {
          lines.push(`  Project: ${p.name}${p.description ? ` — ${p.description}` : ""}`);
          lines.push(bullets("Purpose", p.problem_or_purpose ? [p.problem_or_purpose] : [], "    "));
          lines.push(bullets("Work performed", p.work_performed, "    "));
          lines.push(bullets("Technologies", p.technologies_and_methods, "    "));
          lines.push(bullets("Outcomes", p.outcomes, "    "));
          lines.push(bullets("Metrics", p.metrics, "    "));
          lines.push(bullets("Skills demonstrated", p.skills_demonstrated, "    "));
        }
        for (const a of role.achievements) {
          lines.push(`  Achievement: ${a.description}${a.metrics.length ? ` (${a.metrics.join("; ")})` : ""}`);
        }
        return lines.filter(Boolean).join("\n");
      }),
    ),
  );

  parts.push(
    section(
      "Education",
      profile.education.map((e) => {
        const span = [e.start_date, e.end_date].filter(Boolean).join(" – ");
        const lines = [
          `- ${[e.degree, e.field_of_study].filter(Boolean).join(" in ") || "Study"}, ${e.institution}` +
            `${e.specialization ? ` (specialization: ${e.specialization})` : ""}${span ? ` (${span})` : ""}`,
          bullets("Coursework", e.coursework),
          bullets("Activities", e.activities),
          bullets("Awards", e.awards_and_honors),
        ];
        for (const p of e.projects) {
          lines.push(`  Project: ${p.name}${p.description ? ` — ${p.description}` : ""}`);
          lines.push(bullets("Work performed", p.work_performed, "    "));
          lines.push(bullets("Technologies", p.technologies_and_methods, "    "));
          lines.push(bullets("Outcomes", p.outcomes, "    "));
          lines.push(bullets("Awards", p.awards_and_honors, "    "));
        }
        for (const r of e.research) {
          lines.push(`  Research: ${r.topic}${r.description ? ` — ${r.description}` : ""}`);
          lines.push(bullets("Contributions", r.contributions, "    "));
          lines.push(bullets("Outcomes", r.outcomes, "    "));
        }
        return lines.filter(Boolean).join("\n");
      }),
    ),
  );

  parts.push(
    section(
      "Independent projects",
      profile.independent_projects.map((p) => {
        const lines = [
          `- ${p.name}${p.project_type ? ` [${p.project_type}]` : ""}${p.dates ? ` (${p.dates})` : ""}` +
            `${p.description ? ` — ${p.description}` : ""}`,
          bullets("Purpose", p.problem_or_purpose ? [p.problem_or_purpose] : []),
          bullets("Work performed", p.work_performed),
          bullets("Technologies", p.technologies_and_methods),
          bullets("Outcomes", p.outcomes),
          bullets("Metrics", p.metrics),
          bullets("Skills demonstrated", p.skills_demonstrated),
        ];
        return lines.filter(Boolean).join("\n");
      }),
    ),
  );

  parts.push(
    section(
      "Research and publications",
      profile.research_and_publications.map((r) => {
        const meta = [r.type, r.venue, r.date, r.authorship_role].filter(Boolean).join(", ");
        return [
          `- ${r.title}${meta ? ` (${meta})` : ""}`,
          bullets("Contributions", r.contributions),
          bullets("Recognition", r.recognition),
        ]
          .filter(Boolean)
          .join("\n");
      }),
    ),
  );

  const evidenced = (label: string, items: EvidencedItem[]) =>
    section(
      label,
      items.map((i) => `- ${i.name}${i.evidence.length ? ` (evidence: ${i.evidence.join("; ")})` : ""}`),
    );

  parts.push(evidenced("Technical skills", profile.technical_skills));
  parts.push(evidenced("Tools and technologies", profile.tools_and_technologies));
  parts.push(evidenced("Professional skills", profile.professional_skills));
  parts.push(evidenced("Domain knowledge", profile.domain_knowledge));
  parts.push(evidenced("Career signals", profile.career_signals));

  parts.push(section("Certifications and training", profile.certifications_and_training.map((c) => `- ${c}`)));
  parts.push(section("Awards and honors", profile.independent_awards_and_honors.map((a) => `- ${a}`)));
  parts.push(section("Community and volunteer", profile.community_outreach_and_volunteer.map((c) => `- ${c}`)));
  parts.push(section("Professional memberships", profile.professional_memberships.map((m) => `- ${m}`)));
  parts.push(section("Languages", profile.languages.map((l) => `- ${l}`)));
  parts.push(section("Other", profile.other.map((o) => `- ${o.category}: ${o.description}`)));

  return parts.filter(Boolean).join("\n\n");
}

/**
 * The compact rendering, for high-volume prescreening only.
 *
 * Deliberately deterministic rather than model-generated: it costs nothing, is identical on every
 * run, and cannot drift out of sync with the profile the way a cached LLM summary would. Sized for
 * a call that gets re-sent with every batch of postings -- which is exactly the input worth
 * shrinking, and exactly the wrong input for strategic career analysis.
 */
export function buildMatchProfile(profile: CareerProfile | null): string {
  if (!profile) return "";
  const lines: string[] = [];
  if (profile.career_summary.headline) lines.push(profile.career_summary.headline);

  const summary = profile.career_summary.narrative_summary;
  if (summary) lines.push(summary.length > 400 ? `${summary.slice(0, 400).trimEnd()}…` : summary);

  const roles = profile.work_experience.slice(0, 6).map((e) => {
    const span = [e.start_date, e.current ? "Present" : e.end_date].filter(Boolean).join("–");
    return `${e.title} at ${e.organization}${span ? ` (${span})` : ""}`;
  });
  if (roles.length) lines.push(`Experience: ${roles.join("; ")}`);

  const degrees = profile.education.slice(0, 3).map((e) => {
    const what = [e.degree, e.field_of_study].filter(Boolean).join(" in ");
    return `${what || "Study"}, ${e.institution}${e.end_date ? ` ${e.end_date}` : ""}`;
  });
  if (degrees.length) lines.push(`Education: ${degrees.join("; ")}`);

  // Tools are the highest-signal-per-token thing a prescreen can match on, so they get a slot of
  // their own rather than being merged into the skills line and truncated away.
  const skills = profile.technical_skills.slice(0, 30).map((s) => s.name);
  if (skills.length) lines.push(`Skills: ${skills.join(", ")}`);
  const tools = profile.tools_and_technologies.slice(0, 30).map((t) => t.name);
  if (tools.length) lines.push(`Tools: ${tools.join(", ")}`);
  const domains = profile.domain_knowledge.slice(0, 10).map((d) => d.name);
  if (domains.length) lines.push(`Domains: ${domains.join(", ")}`);

  return lines.join("\n").slice(0, 2000);
}

/**
 * Every concrete evidence string in the profile, for the resume grounding check.
 *
 * The check asks "does this resume bullet correspond to something the candidate can actually
 * prove?", so this deliberately returns the leaf text -- bullets, outcomes, metrics, skills --
 * rather than headings.
 */
export function profileEvidenceStrings(profile: CareerProfile): string[] {
  const out: string[] = [];
  const push = (...items: string[]) => {
    for (const item of items) if (item) out.push(item);
  };

  push(profile.career_summary.headline, profile.career_summary.narrative_summary);
  for (const role of profile.work_experience) {
    push(role.organization, role.title, role.description);
    push(...role.responsibilities, ...role.leadership_and_management, ...role.mentoring_and_teaching);
    push(...role.stakeholder_and_client_work, ...role.communication_and_documentation);
    push(...role.technologies_and_methods, ...role.skills_demonstrated);
    for (const p of role.projects) {
      push(p.name, p.description, p.problem_or_purpose);
      push(...p.work_performed, ...p.technologies_and_methods, ...p.outcomes, ...p.metrics, ...p.skills_demonstrated);
    }
    for (const a of role.achievements) push(a.description, ...a.metrics);
  }
  for (const e of profile.education) {
    push(e.institution, e.degree, e.field_of_study, e.specialization);
    push(...e.coursework, ...e.activities, ...e.awards_and_honors);
    for (const p of e.projects) {
      push(p.name, p.description, ...p.work_performed, ...p.technologies_and_methods, ...p.outcomes, ...p.awards_and_honors);
    }
    for (const r of e.research) push(r.topic, r.description, ...r.contributions, ...r.outcomes);
  }
  for (const p of profile.independent_projects) {
    push(p.name, p.description, p.problem_or_purpose);
    push(...p.work_performed, ...p.technologies_and_methods, ...p.outcomes, ...p.metrics, ...p.skills_demonstrated);
  }
  for (const r of profile.research_and_publications) {
    push(r.title, r.venue, r.topic, ...r.contributions, ...r.recognition);
  }
  for (const list of [profile.technical_skills, profile.tools_and_technologies, profile.professional_skills, profile.domain_knowledge]) {
    for (const item of list) push(item.name, ...item.evidence);
  }
  push(...profile.certifications_and_training, ...profile.independent_awards_and_honors);
  push(...profile.community_outreach_and_volunteer, ...profile.professional_memberships, ...profile.languages);
  return out;
}

/** The flat skill vocabulary, for consumers that just want "what can this person do" as words. */
export function profileSkillNames(profile: CareerProfile): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [profile.technical_skills, profile.tools_and_technologies, profile.professional_skills]) {
    for (const item of list) {
      const key = item.name.toLowerCase();
      if (item.name && !seen.has(key)) {
        seen.add(key);
        out.push(item.name);
      }
    }
  }
  return out;
}
