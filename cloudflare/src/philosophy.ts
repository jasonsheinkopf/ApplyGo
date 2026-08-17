// The resume doctrine agent.
//
// Everywhere else in this app, "what goes on the resume" was an implicit judgment folded into one
// compose prompt. This module makes it explicit and inspectable, because it is the single decision
// that most determines whether a resume works.
//
// The governing idea, which the rest of this file implements:
//
//   A resume is not an autobiography. It is an evidence package answering one question:
//   "why should this employer believe this person can succeed in this particular job?"
//
// That reframes the unit of decision. The unit is NOT the job the candidate held -- it is the
// individual piece of evidence inside that job. Seven years of teaching is neither relevant nor
// irrelevant on its own; it contains curriculum design, adult training, stakeholder handling,
// assessment-data analysis, and possibly a Python automation project, and different targets
// activate different subsets. The historical fact never changes. Its evidentiary value changes
// because the question changed.
//
// Where the rules come from (each is cited at the rule itself below, so a future edit can tell
// which claims are sourced and which are this app's own heuristics):
//
//   - Randazzo, "A Framework for Resume Decisions: Comparing Applicants' and Employers' Reasons",
//     Business and Professional Communication Quarterly 83(4), 2020. Studied 63 applicants/students,
//     20 advisers, and 24 employers, and found eight recurring reasons behind resume decisions:
//     relevance, recency, value, personality, fluff, unprofessionalism, discrimination, and
//     applicant fit. Its own conclusion is that these should be taught as adaptive reasons rather
//     than rigid rules -- which is why this module scores and ranks rather than hard-coding
//     "always/never" verdicts.
//   - UC Berkeley Career Engagement: keep a comprehensive *master* resume of everything, then copy
//     and tailor it per opportunity. This is the archive-then-generate architecture.
//   - Harvard Mignone Center for Career Success: the finished document is concise, factual,
//     skimmable, results-oriented, tailored; not every experience must relate directly.
//   - NACE Job Outlook 2026: 70% of employers report skills-based hiring (up from 65%), and GPA
//     screening fell to 42% from 73% in 2019. Employers want evidence of demonstrated competency,
//     which is why coverage of stated requirements is checked before space is optimized.
//   - Yale Office of Career Strategy: out-of-industry work belongs when its skills translate into
//     competencies the target field values.
//   - Neumark, Burn & Button, "Is It Harder for Older Workers to Find Jobs?" (NBER w21669; J. Pol.
//     Econ.), 40,000+ applications, found robust hiring discrimination against older women. Paired
//     with the ADEA's protection for workers 40+, that is why age-proxy information is not given
//     resume space by default -- not concealment, just declining to spend space on a signal that
//     carries documented downside and little evidentiary value.
//
// Division of labor, following the same "model proposes, code owns the record" split the fit
// pipeline already runs on: the model reads a posting and a profile and proposes a plan, but code
// owns the enum of presentation levels, the bullet budgets, the graduation-date policy, and --
// most importantly -- the verification that every piece of cited evidence actually traces back to
// the candidate's profile. A confident fabrication is the one failure mode that makes this whole
// feature worse than useless, so it is caught in code rather than trusted to a prompt.

import { type LlmEnv, type Provider, callStructured } from "./llm.ts";
import { getManagedPrompt } from "./langfuse.ts";
import type { StructuredProfile } from "./resume";
import { profileEvidenceStrings, renderCareerProfile } from "./profile.ts";

// ---------------------------------------------------------------------------
// Canonical resume guidance -- the one authoritative statement of house style
// ---------------------------------------------------------------------------

/**
 * The single source of truth for how ApplyGo writes and evaluates resume evidence.
 *
 * This lives in code rather than only in a Markdown file because it has two consumers that must
 * not drift apart: the resume writer (which must follow it) and the Strengthen Profile question
 * generator (which must know what *makes* evidence resume-grade, so it can tell that "Used PyTorch
 * for machine learning" is a weak claim worth asking about). A doc alone would let those two
 * quietly diverge; a shared constant cannot. `docs/product/resume-guidelines.md` is the prose
 * companion and cites this constant as the canonical version rather than restating the rules.
 *
 * Sources, synthesized rather than copied:
 *   - The r/EngineeringResumes wiki (mirrored at github.com/r-engineeringresumes/subreddit-wiki),
 *     which is where the bullet-level craft rules come from: STAR/CAR/XYZ as reasoning frames,
 *     strong past-tense action verbs and the specific weak-verb blocklist, 1-2 line bullets ordered
 *     most-relevant-first, no personal pronouns, no adjective/adverb padding, digits over words,
 *     context over parts-lists ("why integration matters"), skills as a comma-separated list of
 *     things actually used rather than a buzzword dump, and the "your resume is not your job
 *     description" framing that separates accomplishments from duties.
 *   - The research already cited at the top of this file (Randazzo; Berkeley; Harvard; NACE; Yale;
 *     Neumark/Burn/Button), which governs selection: what earns space, and why.
 *
 * The two agree more than they disagree. Where the wiki gives a formatting rule that this app's
 * renderer already owns deterministically (fonts, margins, date alignment, page count), that rule
 * is deliberately NOT repeated here -- it belongs to `renderResumeHtml`/`LayoutSpec`, and telling a
 * language model to control typography it cannot see would be noise.
 */
export const RESUME_GUIDANCE = `HOW TO WRITE THIS RESUME (house style -- these are not suggestions):

EVIDENCE, NOT DUTIES
- A resume is not a job description. A bullet that only names a responsibility ("Responsible for
  maintaining the data pipeline") is wasted space when an accomplishment is available.
- Every bullet should do at least one of: show the technical work actually done, show a real
  problem/constraint that was overcome, or show what resulted.
- STAR (situation/task/action/result), CAR (challenge/action/result) and XYZ (accomplished X as
  measured by Y by doing Z) are reasoning frames for finding the missing half of a weak bullet.
  Use them to think, not as a template -- bullets that all follow one visible formula read as
  generated. Vary the sentence shape.

BULLET CRAFT
- Start each bullet with a strong past-tense action verb: analyzed, architected, automated, built,
  created, decreased, designed, developed, implemented, improved, migrated, optimized, reduced,
  refactored, shipped, validated.
- Do NOT open with weak or filler verbs: aided, assisted, collaborated, communicated, executed,
  exposed to, gained experience, helped, participated, used, utilized, worked on. Do not use
  inflated verbs either: spearheaded, orchestrated, pioneered, revolutionized, engineered (as a
  generic verb), leveraged, enhanced, crafted, fostered.
- One sentence per bullet, 1-2 lines. Order bullets within a role most relevant/impressive first.
- No personal pronouns (I, we, my, our). No terminal periods on bullets.
- Cut adjectives and adverbs that carry no evidence: excellent, innovative, expert, world-class,
  successfully, diligently, meticulously, strategically. If a claim needs an adjective to sound
  impressive, it is not yet evidence.
- Use digits for numbers (8, not eight).

TECHNICAL SPECIFICITY AND CONTEXT
- Name the technology in the context of the work it did, never as a bare parts list. "Used Kafka,
  Redis, and Postgres" tells the reader nothing; what the system did, what constraint forced that
  choice, and what it achieved does.
- Prefer the engineering judgment over the tool. The tool is how; the interesting part is what
  problem was identified and what decision was made.
- Spell out a non-obvious abbreviation once, at first use.

QUANTIFICATION -- ONLY WHEN REAL
- Include a metric when the evidence genuinely contains one, and put it early in the bullet.
- Never invent, estimate, round, extrapolate, or "reasonably infer" a number. A fabricated metric
  is the single worst failure mode of this system.
- A strong qualitative outcome (a decision changed, a system shipped, a customer accepted it, a
  process replaced) is legitimate evidence and belongs on the page when no number exists. Do not
  drop a real accomplishment because it has no percentage attached.

SKILLS
- List skills actually used, drawn from evidence that appears elsewhere in the record. A skill in
  the skills list with no supporting history is a claim with no evidence behind it.
- Do not list soft skills (teamwork, leadership, communication) -- demonstrate them in bullets.
- Do not list assumed tools (IDEs, operating systems, word processors, Git hosting sites; "Git" is
  a skill, "GitHub" is not).
- Order most relevant first, and keep proper capitalization (SolidWorks, LabVIEW, PyTorch).

TAILORING, TERMINOLOGY, AND WHAT THIS IS NOT
- Emphasis is tailored to the target: the same career yields different resumes for different roles
  because the question changed, not because the facts did.
- Use the posting's own exact terminology WHEN it truthfully describes what the candidate did --
  that is how both a human reader and a keyword search recognize the match.
- Do NOT keyword-stuff, and do NOT restate a requirement as if it were experience. If the candidate
  used an adjacent tool, say the adjacent tool by its real name. Never upgrade adjacent experience
  into the exact thing the posting asked for.
- A visible gap is an acceptable, honest outcome. Nobody satisfies 100% of a posting.

MODERN SCREENING, REALISTICALLY
- There is no universal "ATS score" to optimize against. Real pipelines mix parsing, structured
  filters and knockout questions, exact keyword search, semantic matching, AI-assisted criteria
  evaluation, ranking, and human review.
- The single strategy that serves all of them is the same one that serves a human reader: accurate,
  specific, well-organized evidence in the words the field actually uses. Write for that.`;

// ---------------------------------------------------------------------------
// Requirements model -- what the target actually asks for
// ---------------------------------------------------------------------------

export type RequirementKind = "must_have" | "responsibility" | "preferred" | "competency";

export type JobRequirement = {
  /** Assigned by code after normalization, so coverage can reference a requirement stably. */
  id: string;
  text: string;
  kind: RequirementKind;
};

export type JobRequirements = {
  role_summary: string;
  requirements: JobRequirement[];
};

const REQUIREMENT_KINDS: RequirementKind[] = ["must_have", "responsibility", "preferred", "competency"];

export const REQUIREMENTS_SCHEMA = {
  type: "object",
  properties: {
    role_summary: {
      type: "string",
      description: "One sentence: what this role actually is, in plain language.",
    },
    requirements: {
      type: "array",
      description:
        "Every distinct thing the posting asks for, split into separate entries. Split compound " +
        "requirements apart ('Python and SQL' is two). Do not invent requirements the posting " +
        "does not state. 25 entries maximum.",
      items: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The requirement in a few words, as the posting frames it, e.g. 'curriculum development'.",
          },
          kind: {
            type: "string",
            enum: REQUIREMENT_KINDS,
            description:
              "must_have = stated as required/minimum. responsibility = a core duty of the job. " +
              "preferred = explicitly nice-to-have. competency = a cross-functional skill like " +
              "communication, leadership, or project management.",
          },
        },
        required: ["text", "kind"],
      },
    },
  },
  required: ["role_summary", "requirements"],
} as const;

/** Caps the requirement list. A posting yielding 40 "requirements" has stopped being useful. */
const MAX_REQUIREMENTS = 25;

/**
 * Reads a posting into a structured requirements model.
 *
 * This exists because scoring a whole resume against a whole posting by overall similarity hides
 * exactly the thing that matters: whether each individual stated requirement is answered. NACE's
 * finding that employers increasingly screen on demonstrated skills is the practical case for
 * treating requirements as a checklist to cover rather than a bag of words to resemble.
 */
export async function extractJobRequirements(
  env: LlmEnv,
  provider: Provider,
  job: { title: string; company: string; description: string },
): Promise<JobRequirements> {
  const prompt = await getManagedPrompt(env, "resume/requirements", {
    job_title: job.title,
    company: job.company,
    job_description: job.description.slice(0, 8000),
  });

  const raw = await callStructured<{ role_summary?: string; requirements?: { text?: string; kind?: string }[] }>(
    env,
    provider,
    "resume.requirements",
    prompt,
    REQUIREMENTS_SCHEMA,
    "submit_requirements",
    3000,
  );
  return normalizeRequirements(raw);
}

/** Code owns the ids and the kind enum, so a reworded or invented kind can't corrupt the record. */
export function normalizeRequirements(raw: {
  role_summary?: string;
  requirements?: { text?: string; kind?: string }[];
}): JobRequirements {
  const seen = new Set<string>();
  const requirements: JobRequirement[] = [];
  for (const item of raw.requirements ?? []) {
    const text = String(item?.text ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const kind = REQUIREMENT_KINDS.includes(item?.kind as RequirementKind)
      ? (item!.kind as RequirementKind)
      : "responsibility";
    requirements.push({ id: `r${requirements.length + 1}`, text, kind });
    if (requirements.length >= MAX_REQUIREMENTS) break;
  }
  return { role_summary: String(raw.role_summary ?? "").trim(), requirements };
}

// ---------------------------------------------------------------------------
// The evidence plan -- what gets featured, included, compressed, omitted
// ---------------------------------------------------------------------------

export type PresentationLevel = "feature" | "include" | "compress" | "omit";

export const PRESENTATION_LEVELS: PresentationLevel[] = ["feature", "include", "compress", "omit"];

/**
 * How many bullets each level buys. Code owns this rather than the model, because "how much space
 * does FEATURE mean" is a document-design decision that must stay identical across every resume,
 * not something to be re-litigated per generation.
 */
export const BULLET_BUDGET: Record<PresentationLevel, number> = {
  feature: 5,
  include: 3,
  compress: 1,
  omit: 0,
};

export type RolePlan = {
  company: string;
  title: string;
  level: PresentationLevel;
  /** Derived in code from `level`. */
  bullet_budget: number;
  rationale: string;
};

export type CoverageStatus = "proven" | "partial" | "unproven";

export type CoverageItem = {
  requirement: string;
  kind: RequirementKind;
  status: CoverageStatus;
  /** Which profile evidence supports it. Empty when unproven. */
  evidence: string;
};

export type EvidencePlan = {
  roles: RolePlan[];
  coverage: CoverageItem[];
  /** Competencies with more supporting evidence than they need, so compose stops at one example. */
  redundant_themes: string[];
  notes: string;
};

const COVERAGE_STATUSES: CoverageStatus[] = ["proven", "partial", "unproven"];

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    roles: {
      type: "array",
      description: "One entry for every role in the candidate profile. Do not skip any.",
      items: {
        type: "object",
        properties: {
          company: { type: "string", description: "Copied verbatim from the profile." },
          title: { type: "string", description: "Copied verbatim from the profile." },
          level: {
            type: "string",
            enum: PRESENTATION_LEVELS,
            description:
              "feature = directly proves core requirements, deserves prominence. include = normal " +
              "entry. compress = title/employer/dates only, kept for chronology. omit = leave off " +
              "this document entirely.",
          },
          rationale: { type: "string", description: "One short sentence on why this level." },
        },
        required: ["company", "title", "level", "rationale"],
      },
    },
    coverage: {
      type: "array",
      description: "One entry per requirement you were given, in the same order.",
      items: {
        type: "object",
        properties: {
          requirement: { type: "string", description: "Copied verbatim from the requirement list." },
          status: {
            type: "string",
            enum: COVERAGE_STATUSES,
            description:
              "proven = the profile clearly demonstrates it. partial = related but not a direct " +
              "match. unproven = the profile contains nothing supporting it.",
          },
          evidence: {
            type: "string",
            description:
              "The specific profile accomplishment that supports it, quoted or closely paraphrased. " +
              "Empty string when unproven. Never write evidence that is not in the profile.",
          },
        },
        required: ["requirement", "status", "evidence"],
      },
    },
    redundant_themes: {
      type: "array",
      description:
        "Competencies the profile can prove several times over, where only the single strongest " +
        "example should reach the page.",
      items: { type: "string" },
    },
    notes: { type: "string", description: "Anything the writer should know. Empty string if nothing." },
  },
  required: ["roles", "coverage", "redundant_themes", "notes"],
} as const;

/**
 * Decides, per role, how much of the page it earns against this specific target.
 *
 * Runs before composition rather than inside it because the two decisions genuinely differ in kind:
 * this one is triage across the whole career, and writing a good bullet is a local craft problem.
 * Folding them together is what produces the failure mode where a model writes beautiful bullets
 * for the wrong three jobs.
 */
export async function planEvidence(
  env: LlmEnv,
  provider: Provider,
  profile: StructuredProfile,
  requirements: JobRequirements,
  targetLabel: string,
): Promise<EvidencePlan> {
  const prompt = await getManagedPrompt(env, "resume/plan_evidence", {
    target: targetLabel,
    role_summary: requirements.role_summary ? `WHAT THE ROLE IS: ${requirements.role_summary}` : "",
    requirements: requirements.requirements.map((r) => `- [${r.kind}] ${r.text}`).join("\n"),
    candidate_profile: renderCareerProfile(profile),
  });

  const raw = await callStructured<Partial<EvidencePlan>>(
    env,
    provider,
    "resume.plan_evidence",
    prompt,
    PLAN_SCHEMA,
    "submit_plan",
    4000,
  );
  return normalizePlan(raw, profile, requirements);
}

/**
 * Rebuilds the plan from the profile and the requirement list, taking only judgments from the model.
 *
 * Three things are corrected here rather than trusted:
 *  1. A role the model skipped entirely defaults to `compress`, never to silent omission. Dropping
 *     a job from a resume is a real decision with chronology consequences; it should never happen
 *     because a model's output ran short.
 *  2. `bullet_budget` is derived from the level in code, so the space each level buys is uniform.
 *  3. A coverage entry claiming `proven` is demoted to `unproven` when its evidence text does not
 *     actually trace to the profile. This is the anti-fabrication backstop, and it is the reason
 *     this function exists at all -- the whole feature is worse than useless if it can invent a
 *     qualification, and prompting alone cannot guarantee it did not.
 */
export function normalizePlan(
  raw: Partial<EvidencePlan>,
  profile: StructuredProfile,
  requirements: JobRequirements,
): EvidencePlan {
  const byRole = new Map<string, { level: PresentationLevel; rationale: string }>();
  for (const r of raw.roles ?? []) {
    const key = roleKey(String(r?.company ?? ""), String(r?.title ?? ""));
    if (!key) continue;
    const level = PRESENTATION_LEVELS.includes(r?.level as PresentationLevel)
      ? (r!.level as PresentationLevel)
      : "include";
    byRole.set(key, { level, rationale: String(r?.rationale ?? "").trim() });
  }

  const roles: RolePlan[] = (profile.work_experience ?? []).map((e) => {
    const decided = byRole.get(roleKey(e.organization, e.title));
    const level = decided?.level ?? "compress";
    return {
      company: e.organization,
      title: e.title,
      level,
      bullet_budget: BULLET_BUDGET[level],
      rationale: decided?.rationale || "No decision returned for this role; kept for chronology.",
    };
  });

  const haystack = profileHaystack(profile);
  const vocabulary = profileVocabulary(profile);
  const byRequirement = new Map<string, { status: CoverageStatus; evidence: string }>();
  for (const c of raw.coverage ?? []) {
    const key = matchKey(String(c?.requirement ?? ""));
    if (!key) continue;
    const status = COVERAGE_STATUSES.includes(c?.status as CoverageStatus)
      ? (c!.status as CoverageStatus)
      : "unproven";
    byRequirement.set(key, { status, evidence: String(c?.evidence ?? "").trim() });
  }

  const coverage: CoverageItem[] = requirements.requirements.map((r) => {
    const decided = byRequirement.get(matchKey(r.text));
    const claimed = decided?.status ?? "unproven";
    const evidence = decided?.evidence ?? "";
    // A claim of support with no evidence, or with evidence that isn't in the profile, is exactly
    // the fabrication this whole module has to prevent. Demote rather than repair: an unproven
    // requirement is an honest, useful signal ("you can't show this yet"), while a repaired one
    // would be a guess presented as a fact.
    const supported = evidence.length > 0 && evidenceTracesToProfile(evidence, haystack);
    let status: CoverageStatus = claimed === "unproven" ? "unproven" : supported ? claimed : "unproven";
    // Second, narrower check, and the one that catches the harder failure. The test above only asks
    // "is this evidence text real?", which a model can satisfy while still citing the wrong thing:
    // quoting genuine Plotly work as proof of a D3.js requirement passes it, because every word of
    // the quote really is in the profile. What that misses is whether the evidence is about *this
    // requirement*. So a `proven` claim additionally has to show that the requirement's own
    // distinctive vocabulary appears somewhere in the record -- and when it doesn't, the honest
    // grade is `partial` rather than `unproven`: the model did find real adjacent experience, it
    // just isn't the named thing, and saying so is more useful to the candidate than silence.
    if (status === "proven" && !requirementVocabularyPresent(r.text, vocabulary)) status = "partial";
    return { requirement: r.text, kind: r.kind, status, evidence: status === "unproven" ? "" : evidence };
  });

  return {
    roles,
    coverage,
    redundant_themes: (raw.redundant_themes ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 10),
    notes: String(raw.notes ?? "").trim(),
  };
}

function matchKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function roleKey(company: string, title: string): string {
  const key = `${matchKey(company)}|${matchKey(title)}`;
  return key === "|" ? "" : key;
}

/**
 * Every word the profile actually contains, for checking that cited evidence isn't invented.
 *
 * Sourced from `profileEvidenceStrings`, which walks the whole canonical record -- project work,
 * outcomes, metrics, mentoring, per-role skills -- rather than the handful of fields the old flat
 * profile exposed. That breadth matters here specifically: this set is what decides whether a
 * `proven` coverage claim survives, so anything it cannot see is a real capability the candidate
 * gets no credit for.
 */
function profileHaystack(profile: StructuredProfile): Set<string> {
  const words = new Set<string>();
  for (const value of profileEvidenceStrings(profile)) {
    for (const word of matchKey(value).split(" ")) if (word.length > 3) words.add(word);
  }
  return words;
}

/**
 * The same walk as `profileHaystack`, but keeping short tokens.
 *
 * A separate set rather than a loosened threshold on the one above, because these two checks want
 * opposite things from short words. `evidenceTracesToProfile` compares a *sentence* against the
 * record and drops them as noise -- "the", "was", "for" would match everything and inflate its
 * overlap ratio. `requirementVocabularyPresent` compares a *term*, where the short ones are
 * frequently the whole point: SQL, AWS, C++, R, Go, ETL, CAD. Filtering those out would silently
 * demote genuine matches for exactly the skills most likely to be named as a hard requirement.
 */
function profileVocabulary(profile: StructuredProfile): Set<string> {
  const words = new Set<string>();
  for (const value of profileEvidenceStrings(profile)) {
    for (const word of matchKey(value).split(" ")) if (word.length > 1) words.add(word);
  }
  return words;
}

/**
 * Deliberately a content-word overlap test, not an exact-substring one.
 *
 * The model is *asked* to paraphrase evidence, and legitimate paraphrase ("delivered CRM
 * onboarding" for "taught staff to use our customer database") shares few exact strings with its
 * source. An exact-match check would therefore reject the honest case constantly and teach nobody
 * anything. What actually distinguishes fabrication is that an invented accomplishment shares
 * almost no specific vocabulary with the profile at all, which this does catch.
 */
function evidenceTracesToProfile(evidence: string, haystack: Set<string>): boolean {
  const words = matchKey(evidence).split(" ").filter((w) => w.length > 3);
  if (!words.length) return false;
  const hits = words.filter((w) => haystack.has(w)).length;
  return hits / words.length >= 0.4;
}

/**
 * Words too generic to identify what a requirement is actually asking for.
 *
 * Requirements are phrased as prose ("experience with strong knowledge of Kubernetes"), and the
 * filler carries no evidentiary weight -- if these counted, virtually every requirement would find
 * a match in virtually every profile and the check below would pass everything.
 */
const REQUIREMENT_STOPWORDS = new Set([
  "ability", "advanced", "and", "background", "based", "best", "building", "collaborate",
  "deep", "demonstrated", "developing", "environment", "excellent", "experience", "expertise",
  "familiarity", "for", "from", "good", "hands", "have", "high", "including", "knowledge",
  "level", "modern", "practical", "practices", "proficiency", "proven", "related", "relevant",
  "skills", "solid", "strong", "the", "them", "these", "this", "understanding", "using", "with",
  "work", "working", "year", "years",
]);

/**
 * Whether the record mentions what this requirement actually names.
 *
 * Deliberately a very low bar -- ONE distinctive term is enough -- because it is a veto on the
 * strongest claim, not a scoring function. Requiring more would demote genuine matches whenever the
 * candidate happens to describe the same competency in different words ("stakeholder communication"
 * evidenced by "presented to stakeholders"), which is exactly the honest paraphrase the sibling
 * check above exists to protect. What it does reliably catch is the case that matters: a named
 * technology, tool, certification or framework that appears nowhere in the candidate's history.
 *
 * Prefix matching rather than exact, for tokens long enough that a shared prefix means something,
 * so ordinary morphology (stakeholder/stakeholders, deploy/deployment) is not read as a mismatch.
 * Short tokens like "d3" or "go" must match exactly -- a prefix rule would let "go" match
 * "governance", which is how a check like this turns into a rubber stamp.
 */
export function requirementVocabularyPresent(requirement: string, haystack: Set<string>): boolean {
  const tokens = matchKey(requirement)
    .split(" ")
    .filter((t) => t.length > 1 && !REQUIREMENT_STOPWORDS.has(t));
  // Nothing distinctive to check (a requirement made entirely of filler) is not evidence of
  // fabrication, so it passes rather than demoting a claim on a technicality.
  if (!tokens.length) return true;

  for (const token of tokens) {
    if (haystack.has(token)) return true;
    if (token.length >= 4) {
      for (const word of haystack) {
        if (word.startsWith(token) || token.startsWith(word)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Deterministic policies -- decisions that shouldn't be a model's to make
// ---------------------------------------------------------------------------

/**
 * Whether a graduation year earns its space.
 *
 * Early on it is genuinely informative: it communicates career stage and availability, which is why
 * student-facing guidance includes an expected graduation date. Its evidentiary value then decays
 * to roughly nothing while its value as an age proxy does not -- and age proxies have documented
 * hiring cost (Neumark/Burn/Button; ADEA covers workers 40+).
 *
 * This is emphatically not "hide the candidate's age": the degree, institution, and field all stay,
 * and employment dates are untouched (those carry real chronology and ATS-parsing value). It is
 * only a judgment that after a decade of professional history, a graduation year buys less than the
 * space it costs. A posting that genuinely requires recent completion of a program is the exception,
 * which is why this returns a recommendation the caller can override rather than a hard rule.
 */
export function graduationDatePolicy(yearsSinceGraduation: number | null): "include" | "optional" | "omit" {
  if (yearsSinceGraduation === null || yearsSinceGraduation < 0) return "include";
  if (yearsSinceGraduation <= 5) return "include";
  if (yearsSinceGraduation <= 10) return "optional";
  return "omit";
}

/**
 * How much weight age alone should carry, before relevance is considered.
 *
 * A decay curve rather than the conventional 10-to-15-year cliff, because a cliff produces the
 * wrong answer at the edges in both directions: a mundane accomplishment from four years ago that
 * proves nothing about the target does not deserve space, and a rare, exactly-on-point
 * accomplishment from seventeen years ago sometimes does. Relevance is scored separately and is
 * allowed to outrank this.
 */
export function recencyWeight(yearsAgo: number): number {
  if (yearsAgo <= 3) return 1;
  if (yearsAgo <= 7) return 0.8;
  if (yearsAgo <= 12) return 0.55;
  if (yearsAgo <= 18) return 0.3;
  return 0.15;
}

// ---------------------------------------------------------------------------
// Rendering the plan into prompt text for the writer
// ---------------------------------------------------------------------------

/**
 * Turns a plan into instructions the compose step follows.
 *
 * The unproven block is the important one and is stated as a prohibition rather than an omission:
 * left implicit, a writer that knows the target wants Kubernetes will reliably find some way to
 * gesture at Kubernetes.
 */
export function renderPlanDirective(plan: EvidencePlan): string {
  const lines: string[] = ["EVIDENCE PLAN (already decided -- follow it rather than re-deciding):"];

  for (const role of plan.roles) {
    const where = `${role.title} at ${role.company}`;
    if (role.level === "omit") {
      lines.push(`- OMIT ${where}. Leave it off this resume entirely. ${role.rationale}`);
    } else if (role.level === "compress") {
      lines.push(`- COMPRESS ${where}: title, employer, and dates, at most 1 bullet. ${role.rationale}`);
    } else {
      lines.push(
        `- ${role.level.toUpperCase()} ${where}: up to ${role.bullet_budget} bullets. ${role.rationale}`,
      );
    }
  }

  const proven = plan.coverage.filter((c) => c.status === "proven");
  if (proven.length) {
    lines.push("", "MUST BE VISIBLY SUPPORTED -- the reader has to be able to find evidence for each:");
    for (const c of proven) lines.push(`- ${c.requirement} (via: ${c.evidence})`);
  }

  const partial = plan.coverage.filter((c) => c.status === "partial");
  if (partial.length) {
    lines.push("", "PARTIALLY SUPPORTED -- include the honest adjacent evidence, do not overstate the match:");
    for (const c of partial) lines.push(`- ${c.requirement} (closest: ${c.evidence})`);
  }

  const unproven = plan.coverage.filter((c) => c.status === "unproven");
  if (unproven.length) {
    lines.push(
      "",
      "NOT SUPPORTED BY THE PROFILE. Write nothing that claims, implies, or hints at these. Do not",
      "reach for a loosely adjacent accomplishment to cover them. Leaving a gap visible is correct:",
    );
    for (const c of unproven) lines.push(`- ${c.requirement}`);
  }

  if (plan.redundant_themes.length) {
    lines.push(
      "",
      `PROVE ONCE, THEN MOVE ON. The profile can demonstrate these repeatedly; use the single strongest example of each and spend the remaining space proving something different: ${plan.redundant_themes.join(", ")}.`,
    );
  }

  if (plan.notes) lines.push("", `PLANNER NOTES: ${plan.notes}`);

  return lines.join("\n");
}

/** Counts requirements by status, for the readiness summary the candidate sees. */
export function coverageSummary(plan: EvidencePlan): { proven: number; partial: number; unproven: number } {
  return {
    proven: plan.coverage.filter((c) => c.status === "proven").length,
    partial: plan.coverage.filter((c) => c.status === "partial").length,
    unproven: plan.coverage.filter((c) => c.status === "unproven").length,
  };
}
