// Resume generation pipeline.
//
// Design principle running through this file: the model writes *content*, code owns *layout*.
// Letting an LLM improvise CSS on every generation is what produces inconsistent, amateur
// output. So composition returns a structured ResumeDoc, a deterministic renderer turns that
// into HTML/PDF using one of three hand-built templates, deterministic checks verify the
// result, and the vision reviewer is only allowed to move a small set of clamped layout knobs
// (plus ask for a content rewrite, which goes back through the same grounded compose step).
//
// The stages are deliberately separable because per-job tailoring will reuse all of them --
// only the "target" input changes, from general desired roles to a specific job posting.

import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { extractText, getDocumentProxy } from "unpdf";
import {
  type LlmEnv,
  type Provider,
  WRITING_STYLE_RULES,
  bytesToBase64,
  callStructured,
  callStructuredWithImage,
} from "./llm";
// Only values flow this way; philosophy.ts takes StructuredProfile back from here as an `import
// type`, which is erased at compile time, so the two files don't form a runtime cycle.
import { MASTER_DOCTRINE, RESUME_DOCTRINE } from "./philosophy";

export interface ResumeEnv extends LlmEnv {
  FILES: R2Bucket;
  BROWSER: BrowserWorker;
  LOCAL_RENDER_URL?: string;
}

/** The candidate evidence model: everything a resume may draw on, and nothing it may invent. */
export type StructuredProfile = {
  headline: string;
  narrative_summary: string;
  education: { school: string; degree: string; field: string; start_year: string; end_year: string }[];
  experience: { company: string; title: string; start: string; end: string; highlights: string[] }[];
  skills: string[];
};

/** One rendered resume's content. Distinct from the profile: selected, ordered, and rewritten. */
export type ResumeDoc = {
  full_name: string;
  contact_line: string;
  headline: string;
  summary: string;
  skill_groups: { label: string; skills: string[] }[];
  experience: { company: string; title: string; location: string; start: string; end: string; bullets: string[] }[];
  projects: { name: string; detail: string; bullets: string[] }[];
  education: { school: string; degree: string; field: string; start_year: string; end_year: string; detail: string }[];
};

export const TEMPLATE_IDS = ["classic", "modern", "compact"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const TEMPLATES: { id: TemplateId; name: string; blurb: string }[] = [
  {
    id: "classic",
    name: "Classic",
    blurb: "Serif, centered name, ruled section headings. The conservative choice recruiters rate highest.",
  },
  {
    id: "modern",
    name: "Modern",
    blurb: "Clean sans-serif, left-aligned masthead, airier spacing. Contemporary without being decorative.",
  },
  {
    id: "compact",
    name: "Compact",
    blurb: "Tighter type and leading, built to keep a dense history on one page without feeling crowded.",
  },
];

/**
 * The only layout surface the vision reviewer may touch. Every field is clamped on the way in,
 * so a bad model response degrades the design slightly rather than breaking the page.
 */
export type LayoutSpec = {
  template: TemplateId;
  font_scale: number;
  spacing: number;
  max_pages: number;
  show_summary: boolean;
  skills_first: boolean;
};

export function defaultLayout(template: TemplateId = "classic"): LayoutSpec {
  return { template, font_scale: 1, spacing: 1, max_pages: 1, show_summary: true, skills_first: false };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeTemplate(value: unknown): TemplateId {
  return TEMPLATE_IDS.includes(value as TemplateId) ? (value as TemplateId) : "classic";
}

export function normalizeLayout(value: unknown): LayoutSpec {
  const raw = (value ?? {}) as Partial<LayoutSpec>;
  const base = defaultLayout();
  return {
    template: normalizeTemplate(raw.template),
    font_scale: clamp(raw.font_scale, 0.88, 1.14, base.font_scale),
    spacing: clamp(raw.spacing, 0.78, 1.3, base.spacing),
    max_pages: clamp(raw.max_pages, 1, 2, base.max_pages) >= 1.5 ? 2 : 1,
    show_summary: typeof raw.show_summary === "boolean" ? raw.show_summary : base.show_summary,
    skills_first: typeof raw.skills_first === "boolean" ? raw.skills_first : base.skills_first,
  };
}

export type ResumeCheck = { id: string; severity: "error" | "warning" | "ok"; message: string };

// ---------------------------------------------------------------------------
// Stage 1 -- compose
// ---------------------------------------------------------------------------

export const RESUME_DOC_SCHEMA = {
  type: "object",
  properties: {
    full_name: { type: "string", description: "The candidate's name exactly as it should head the resume." },
    contact_line: {
      type: "string",
      description:
        "A single line of contact details separated by ' | ' (email, phone, city, links) drawn only from the " +
        "profile. Empty string if the profile has none -- never invent contact details.",
    },
    headline: { type: "string", description: "Short professional headline, e.g. 'Applied AI Engineer'." },
    summary: {
      type: "string",
      description: "2-3 sentence positioning summary. Third person, no pronouns. Empty string to omit.",
    },
    skill_groups: {
      type: "array",
      description: "Skills organized into 2-4 labelled groups, e.g. 'Languages', 'ML & Data', 'Infrastructure'.",
      items: {
        type: "object",
        properties: { label: { type: "string" }, skills: { type: "array", items: { type: "string" } } },
        required: ["label", "skills"],
      },
    },
    experience: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          location: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
        },
        required: ["company", "title", "bullets"],
      },
    },
    projects: {
      type: "array",
      description: "Selected projects or publications, only when they strengthen fit. Often empty.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          detail: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
        },
        required: ["name"],
      },
    },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          school: { type: "string" },
          degree: { type: "string" },
          field: { type: "string" },
          start_year: { type: "string" },
          end_year: { type: "string" },
          detail: { type: "string" },
        },
        required: ["school"],
      },
    },
  },
  required: ["full_name", "contact_line", "headline", "summary", "skill_groups", "experience", "projects", "education"],
} as const;

/**
 * The writing rules. These are split the way the evidence actually splits: hard constraints come
 * from ATS-vendor parsing documentation and from the requirement not to lie; strong defaults come
 * from recruiter research and broad professional convention; the rest are tunable preferences.
 */
/**
 * The constraints that hold no matter what the document is for. Split out from COMPOSE_RULES so the
 * master archive can take these without also taking the selection defaults below -- "be selective",
 * "3-5 bullets", and "drop irrelevant roles" are exactly what that document must not do.
 */
const COMPOSE_RULES_TRUTH_ONLY = `
${WRITING_STYLE_RULES}

This document goes to an employer, so the register is formal throughout. No casual phrasing, no
conversational asides, no rhetorical questions.

HARD CONSTRAINTS (never violate):
- Never invent an employer, title, date, degree, credential, metric, or accomplishment. Every claim must
  trace to the profile below. If something would strengthen the resume but is not in the profile, omit it.
- Never invent contact details. Use only what the profile contains.
- Do not inflate scope or seniority. Do not imply a result was validated if the profile does not say so.
- Dates must stay consistent with the profile.
- No first-person pronouns. No "Responsible for". No sentence-ending periods on fragment bullets is fine,
  but be consistent.
`.trim();

const COMPOSE_RULES = `
${COMPOSE_RULES_TRUTH_ONLY}

STRONG DEFAULTS (follow unless the user's instructions override):
- Reverse chronological. Experience is the dominant section; education is concise for an experienced candidate.
- Lead with the strongest, most relevant, most recent evidence. Bury nothing important at the bottom.
- Prefer clarity and structure over density of keywords. Clear communication is what actually moves recruiters.
- Rewrite raw profile highlights into achievement bullets. A good bullet combines several of:
  action + technical object + problem or constraint + method + result or decision enabled.
  Weak:   "Responsible for researching datasets for an AI project."
  Strong: "Led a three-path data feasibility study for hybrid-vehicle personalization, evaluating licensable,
           semi-synthetic, and fully synthetic sources against required signals, participant diversity, and cost."
- Quantify only with numbers that are actually present or directly implied. Never fabricate a metric to satisfy
  a "quantify everything" rule. Legitimate non-numeric evidence includes: decisions enabled, risk avoided,
  development unblocked, systems shipped, scope of stakeholders, comparisons run.
- Technical skills should appear in context inside bullets, not only as a list.
- Use the target roles' vocabulary where it is truthful. Do not keyword-stuff.
- 3-5 bullets for the most relevant recent roles, 1-2 for older or less relevant ones. Drop irrelevant roles'
  bullets entirely before dropping the role itself.
`.trim();

/**
 * Extra shaping for one composition, beyond the profile and the target.
 *
 * `master` flips the whole posture: no page budget, no selection, include everything (see
 * MASTER_DOCTRINE). `planDirective` is the pre-decided per-role feature/include/compress/omit plan
 * plus the requirement-coverage report, rendered by `renderPlanDirective` -- when present it
 * outranks the writer's own instincts about what deserves space.
 */
export type ComposeOptions = { master?: boolean; planDirective?: string };

function composePrompt(
  profile: StructuredProfile,
  desiredRoles: string,
  instructions: string,
  layout: LayoutSpec,
  feedback: string,
  options: ComposeOptions,
): string {
  const budget =
    layout.max_pages === 1
      ? "This must fit on ONE US Letter page. Be selective -- that is the point of this step."
      : "This may run to two US Letter pages, but only if the second page is genuinely full.";

  if (options.master) {
    return [
      "You are building a candidate's master career archive as a resume-shaped document.",
      "",
      MASTER_DOCTRINE,
      "",
      COMPOSE_RULES_TRUTH_ONLY,
      "",
      "Include the summary: write a full narrative one, not a tightened positioning line.",
      "",
      instructions ? `USER INSTRUCTIONS:\n${instructions}` : "",
      feedback ? `\nREVISION FEEDBACK -- address this specifically:\n${feedback}` : "",
      "",
      `CANDIDATE PROFILE (the only permitted source of facts):\n${JSON.stringify(profile)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "You are an experienced professional resume writer preparing one resume version for a candidate.",
    "You are given the candidate's full verified profile as evidence, plus the kinds of roles they are targeting.",
    "Select, order, compress, and rewrite that evidence into resume content. You are not writing prose about them;",
    "you are choosing what belongs on the page and stating it well.",
    "",
    RESUME_DOCTRINE,
    "",
    COMPOSE_RULES,
    "",
    `PAGE BUDGET: ${budget}`,
    layout.show_summary
      ? "Include a short summary."
      : "Omit the summary -- return an empty string for it. The page needs the space.",
    "",
    // Placed after the doctrine and before the free-text target: the plan is a decision already
    // made against this specific posting, so it should be read as settled rather than as one more
    // consideration to weigh against the general guidance above.
    options.planDirective ? `${options.planDirective}\n` : "",
    desiredRoles
      ? `TARGET ROLES (what this resume should be angled toward):\n${desiredRoles}`
      : "TARGET ROLES: none specified. Produce a strong general-purpose resume for the candidate's evident field.",
    "",
    instructions
      ? `USER INSTRUCTIONS FOR THIS VERSION (these take priority over the strong defaults):\n${instructions}`
      : "USER INSTRUCTIONS: none.",
    feedback ? `\nREVISION FEEDBACK -- address this specifically in your rewrite:\n${feedback}` : "",
    "",
    `CANDIDATE PROFILE (the only permitted source of facts):\n${JSON.stringify(profile)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function composeResumeDoc(
  env: ResumeEnv,
  provider: Provider,
  profile: StructuredProfile,
  desiredRoles: string,
  instructions: string,
  layout: LayoutSpec,
  feedback = "",
  options: ComposeOptions = {},
): Promise<ResumeDoc> {
  const doc = await callStructured<ResumeDoc>(
    env,
    provider,
    "resume.build",
    composePrompt(profile, desiredRoles, instructions, layout, feedback, options),
    RESUME_DOC_SCHEMA,
    "submit_resume",
    // The archive is meant to be exhaustive, so it needs materially more room to come back whole --
    // a truncated master archive silently loses evidence every later resume is filtered from.
    options.master ? 16000 : 4000,
  );
  return {
    full_name: doc.full_name ?? "",
    contact_line: doc.contact_line ?? "",
    headline: doc.headline ?? "",
    summary: layout.show_summary ? (doc.summary ?? "") : "",
    skill_groups: doc.skill_groups ?? [],
    experience: doc.experience ?? [],
    projects: doc.projects ?? [],
    education: doc.education ?? [],
  };
}

// ---------------------------------------------------------------------------
// Stage 2 -- grounding
// ---------------------------------------------------------------------------

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Anti-fabrication backstop. Prompting alone can't guarantee the model didn't invent an employer,
 * so every organization name on the resume is checked against the profile it was built from.
 */
export function checkGrounding(doc: ResumeDoc, profile: StructuredProfile): ResumeCheck[] {
  const checks: ResumeCheck[] = [];
  const knownCompanies = new Set(profile.experience.map((e) => normalizeForMatch(e.company)));
  const knownSchools = new Set(profile.education.map((e) => normalizeForMatch(e.school)));

  const inventedCompanies = doc.experience
    .map((e) => e.company)
    .filter((c) => c && !knownCompanies.has(normalizeForMatch(c)));
  const inventedSchools = doc.education
    .map((e) => e.school)
    .filter((s) => s && !knownSchools.has(normalizeForMatch(s)));

  if (inventedCompanies.length) {
    checks.push({
      id: "grounding_companies",
      severity: "error",
      message: `Employer(s) not found in your profile: ${inventedCompanies.join(", ")}. Verify before sending.`,
    });
  }
  if (inventedSchools.length) {
    checks.push({
      id: "grounding_schools",
      severity: "error",
      message: `School(s) not found in your profile: ${inventedSchools.join(", ")}. Verify before sending.`,
    });
  }
  if (!inventedCompanies.length && !inventedSchools.length) {
    checks.push({ id: "grounding", severity: "ok", message: "Every employer and school traces back to your profile." });
  }
  return checks;
}

function checkWriting(doc: ResumeDoc): ResumeCheck[] {
  const checks: ResumeCheck[] = [];
  const bullets = [
    ...doc.experience.flatMap((e) => e.bullets ?? []),
    ...doc.projects.flatMap((p) => p.bullets ?? []),
  ];

  const pronouns = bullets.filter((b) => /\b(I|my|me|we|our)\b/i.test(b));
  if (pronouns.length) {
    checks.push({
      id: "pronouns",
      severity: "warning",
      message: `${pronouns.length} bullet(s) use first-person pronouns, which resumes conventionally avoid.`,
    });
  }

  const weak = bullets.filter((b) => /^(responsible for|helped with|worked on|assisted)/i.test(b.trim()));
  if (weak.length) {
    checks.push({
      id: "weak_openers",
      severity: "warning",
      message: `${weak.length} bullet(s) open with a duty phrase rather than an accomplishment.`,
    });
  }

  const overlong = bullets.filter((b) => b.length > 260);
  if (overlong.length) {
    checks.push({
      id: "long_bullets",
      severity: "warning",
      message: `${overlong.length} bullet(s) run past ~3 lines and will be skimmed past.`,
    });
  }

  if (!doc.experience.length) {
    checks.push({ id: "no_experience", severity: "error", message: "No experience section was produced." });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Stage 3 -- render
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type TemplateStyle = {
  bodyFont: string;
  headingFont: string;
  basePt: number;
  namePt: number;
  headingPt: number;
  nameAlign: string;
  nameWeight: number;
  nameTracking: string;
  headingRule: string;
  headingTransform: string;
  headingTracking: string;
  accent: string;
  pagePadding: string;
};

const TEMPLATE_STYLES: Record<TemplateId, TemplateStyle> = {
  classic: {
    bodyFont: "Georgia, 'Times New Roman', Times, serif",
    headingFont: "Georgia, 'Times New Roman', Times, serif",
    basePt: 10.5,
    namePt: 21,
    headingPt: 10.5,
    nameAlign: "center",
    nameWeight: 700,
    nameTracking: "0.02em",
    headingRule: "1px solid #333",
    headingTransform: "uppercase",
    headingTracking: "0.09em",
    accent: "#222",
    pagePadding: "0.6in 0.7in",
  },
  modern: {
    bodyFont: "Helvetica, Arial, 'Liberation Sans', sans-serif",
    headingFont: "Helvetica, Arial, 'Liberation Sans', sans-serif",
    basePt: 10,
    namePt: 23,
    headingPt: 9.5,
    nameAlign: "left",
    nameWeight: 700,
    nameTracking: "-0.015em",
    headingRule: "2px solid #1a1a1a",
    headingTransform: "uppercase",
    headingTracking: "0.13em",
    accent: "#1a1a1a",
    pagePadding: "0.55in 0.65in",
  },
  compact: {
    bodyFont: "Helvetica, Arial, 'Liberation Sans', sans-serif",
    headingFont: "Helvetica, Arial, 'Liberation Sans', sans-serif",
    basePt: 9.5,
    namePt: 18,
    headingPt: 9,
    nameAlign: "left",
    nameWeight: 700,
    nameTracking: "0",
    headingRule: "1px solid #888",
    headingTransform: "uppercase",
    headingTracking: "0.1em",
    accent: "#333",
    pagePadding: "0.45in 0.55in",
  },
};

function renderEntryHeader(left: string, right: string, sub: string): string {
  return `<div class="entry">
    <div class="entry-row"><span class="entry-title">${left}</span><span class="entry-dates">${right}</span></div>
    ${sub ? `<div class="entry-sub">${sub}</div>` : ""}`;
}

export function renderResumeHtml(doc: ResumeDoc, layout: LayoutSpec): string {
  const t = TEMPLATE_STYLES[layout.template];
  const s = layout.font_scale;
  const gap = layout.spacing;
  const pt = (value: number) => `${(value * s).toFixed(2)}pt`;
  const space = (value: number) => `${(value * gap).toFixed(2)}pt`;

  const experienceHtml = (doc.experience ?? [])
    .map((e) => {
      const dates = [e.start, e.end].filter(Boolean).join(" – ");
      const sub = [e.location].filter(Boolean).map(escapeHtml).join("");
      const bullets = (e.bullets ?? []).map((b) => `<li>${escapeHtml(b)}</li>`).join("");
      return `${renderEntryHeader(
        `${escapeHtml(e.title)}${e.company ? `, <span class="org">${escapeHtml(e.company)}</span>` : ""}`,
        escapeHtml(dates),
        sub,
      )}
      ${bullets ? `<ul class="bullets">${bullets}</ul>` : ""}
    </div>`;
    })
    .join("");

  const projectsHtml = (doc.projects ?? [])
    .map((p) => {
      const bullets = (p.bullets ?? []).map((b) => `<li>${escapeHtml(b)}</li>`).join("");
      return `${renderEntryHeader(escapeHtml(p.name), "", escapeHtml(p.detail ?? ""))}
      ${bullets ? `<ul class="bullets">${bullets}</ul>` : ""}
    </div>`;
    })
    .join("");

  const educationHtml = (doc.education ?? [])
    .map((e) => {
      const line = [e.degree, e.field].filter(Boolean).join(", ");
      const dates = [e.start_year, e.end_year].filter(Boolean).join(" – ");
      return `${renderEntryHeader(
        escapeHtml(line || e.school),
        escapeHtml(dates),
        escapeHtml([line ? e.school : "", e.detail].filter(Boolean).join(" · ")),
      )}</div>`;
    })
    .join("");

  const skillsHtml = (doc.skill_groups ?? [])
    .filter((g) => (g.skills ?? []).length)
    .map(
      (g) =>
        `<div class="skill-row"><span class="skill-label">${escapeHtml(g.label)}</span><span class="skill-list">${(
          g.skills ?? []
        )
          .map(escapeHtml)
          .join(" · ")}</span></div>`,
    )
    .join("");

  const section = (title: string, body: string) => (body ? `<h2>${title}</h2>${body}` : "");
  const skillsSection = section("Skills", skillsHtml);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.full_name || "Resume")}</title>
<style>
  @page { size: letter; margin: 0; }
  * { box-sizing: border-box; }
  body {
    font-family: ${t.bodyFont};
    color: #1a1a1a;
    margin: 0;
    padding: ${t.pagePadding};
    font-size: ${pt(t.basePt)};
    line-height: ${(1.4 * gap).toFixed(2)};
    -webkit-font-smoothing: antialiased;
  }
  header { text-align: ${t.nameAlign}; margin-bottom: ${space(9)}; }
  h1 {
    font-family: ${t.headingFont};
    font-size: ${pt(t.namePt)};
    font-weight: ${t.nameWeight};
    letter-spacing: ${t.nameTracking};
    margin: 0 0 ${space(2)};
    color: ${t.accent};
  }
  .headline { font-size: ${pt(t.basePt)}; color: #444; margin: 0 0 ${space(3)}; }
  .contact { font-size: ${pt(t.basePt - 1)}; color: #444; margin: 0; }
  .summary { margin: 0 0 ${space(10)}; }
  h2 {
    font-family: ${t.headingFont};
    font-size: ${pt(t.headingPt)};
    font-weight: 700;
    text-transform: ${t.headingTransform};
    letter-spacing: ${t.headingTracking};
    color: ${t.accent};
    border-bottom: ${t.headingRule};
    padding-bottom: ${space(2)};
    margin: ${space(11)} 0 ${space(6)};
  }
  h2:first-of-type { margin-top: 0; }
  .entry { margin-bottom: ${space(7)}; break-inside: avoid; }
  .entry-row { display: flex; justify-content: space-between; align-items: baseline; gap: 0.75em; }
  .entry-title { font-weight: 700; }
  .entry-title .org { font-weight: 400; }
  .entry-dates { font-size: ${pt(t.basePt - 1)}; color: #555; white-space: nowrap; }
  .entry-sub { font-size: ${pt(t.basePt - 1)}; color: #555; font-style: italic; }
  .bullets { margin: ${space(3)} 0 0; padding-left: ${pt(13)}; }
  .bullets li { margin-bottom: ${space(2.5)}; }
  .skill-row { display: flex; gap: 0.6em; margin-bottom: ${space(2.5)}; }
  .skill-label { font-weight: 700; white-space: nowrap; }
  .skill-list { color: #222; }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(doc.full_name || "Resume")}</h1>
    ${doc.headline ? `<div class="headline">${escapeHtml(doc.headline)}</div>` : ""}
    ${doc.contact_line ? `<p class="contact">${escapeHtml(doc.contact_line)}</p>` : ""}
  </header>
  ${doc.summary ? `<p class="summary">${escapeHtml(doc.summary)}</p>` : ""}
  ${layout.skills_first ? skillsSection : ""}
  ${section("Experience", experienceHtml)}
  ${section("Projects", projectsHtml)}
  ${layout.skills_first ? "" : skillsSection}
  ${section("Education", educationHtml)}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Stage 3b/4 -- render to PDF + screenshot, then verify the artifact
// ---------------------------------------------------------------------------

export type RenderResult = { pdfKey: string; pdfBytes: Uint8Array; screenshotBase64: string };

/**
 * The Browser Rendering binding caps concurrent/per-minute session creation; a generate followed
 * immediately by the automatic design-review render can trip that even though nothing is actually
 * overloaded. A short retry turns that transient 429 into a brief wait instead of a failed
 * generation -- the raw "Unable to create new browser: code: 429" is not something a candidate
 * can act on.
 */
async function launchBrowser(env: ResumeEnv, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await puppeteer.launch(env.BROWSER);
    } catch (err) {
      const message = (err as Error).message || "";
      const isRateLimit = /unable to create new browser/i.test(message) && /(429|rate limit)/i.test(message);
      if (!isRateLimit || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Local development does not require a Cloudflare account. `npm run dev` starts a tiny companion
 * renderer that drives the machine's installed Chrome directly. Miniflare's Browser binding is
 * still tried first, but if its bundled browser cannot spawn we hand the same HTML to that local
 * renderer. Production has no LOCAL_RENDER_URL and therefore continues to use Cloudflare only.
 */
async function renderWithLocalChrome(env: ResumeEnv, html: string): Promise<Omit<RenderResult, "pdfKey">> {
  if (!env.LOCAL_RENDER_URL) throw new Error("local_renderer_not_configured");
  const response = await fetch(`${env.LOCAL_RENDER_URL.replace(/\/$/, "")}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ html }),
  });
  const raw = await response.text();
  let data: { pdf_base64?: string; screenshot_base64?: string; error?: string } = {};
  try { data = JSON.parse(raw); } catch { /* handled below */ }
  if (!response.ok || !data.pdf_base64 || !data.screenshot_base64) {
    throw new Error(data.error || raw || `local_renderer_http_${response.status}`);
  }
  return { pdfBytes: base64ToBytes(data.pdf_base64), screenshotBase64: data.screenshot_base64 };
}

/**
 * One browser session produces both the PDF and the print-media screenshot, so the image the
 * vision reviewer sees is the same rendering the PDF came from.
 */
export async function renderResumeArtifacts(env: ResumeEnv, resumeId: string, html: string): Promise<RenderResult> {
  let artifacts: Omit<RenderResult, "pdfKey">;
  try {
    const browser = await launchBrowser(env);
    try {
      const page = await browser.newPage();
      // 8.5in x 11in at 96dpi, so CSS inches map to the real page.
      await page.setViewport({ width: 816, height: 1056 });
      await page.setContent(html, { waitUntil: "networkidle0" });
      await page.emulateMediaType("print");
      const pdf = await page.pdf({
        format: "letter",
        printBackground: true,
        margin: { top: "0in", bottom: "0in", left: "0in", right: "0in" },
      });
      const shot = await page.screenshot({ type: "jpeg", quality: 80, fullPage: true });
      artifacts = {
        pdfBytes: new Uint8Array(pdf),
        screenshotBase64: bytesToBase64(new Uint8Array(shot)),
      };
    } finally {
      await browser.close();
    }
  } catch (cloudflareError) {
    try {
      artifacts = await renderWithLocalChrome(env, html);
    } catch (localError) {
      throw new Error(
        `Cloudflare browser failed: ${(cloudflareError as Error).message}. ` +
        `Local Chrome fallback failed: ${(localError as Error).message}`,
      );
    }
  }

  const pdfKey = `resumes/${resumeId}.pdf`;
  await env.FILES.put(pdfKey, artifacts.pdfBytes, { httpMetadata: { contentType: "application/pdf" } });
  return { pdfKey, ...artifacts };
}

/**
 * Reads back the PDF we just produced the same way an applicant tracking system would, and
 * confirms the things that matter actually survived text extraction. This catches the failure
 * mode where a resume looks right to a human but parses to garbage.
 */
export async function checkRenderedPdf(
  pdfBytes: Uint8Array,
  doc: ResumeDoc,
  layout: LayoutSpec,
): Promise<ResumeCheck[]> {
  const checks: ResumeCheck[] = [];
  try {
    const pdf = await getDocumentProxy(pdfBytes);
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    const haystack = normalizeForMatch(String(text));

    if (totalPages > layout.max_pages) {
      checks.push({
        id: "page_count",
        severity: "warning",
        message: `Rendered to ${totalPages} pages but the target is ${layout.max_pages}. Run a design review to tighten it.`,
      });
    } else {
      checks.push({
        id: "page_count",
        severity: "ok",
        message: `${totalPages} page${totalPages === 1 ? "" : "s"}, within the ${layout.max_pages}-page target.`,
      });
    }

    const missing: string[] = [];
    if (doc.full_name && !haystack.includes(normalizeForMatch(doc.full_name))) missing.push(doc.full_name);
    for (const e of doc.experience ?? []) {
      if (e.company && !haystack.includes(normalizeForMatch(e.company))) missing.push(e.company);
    }
    for (const e of doc.education ?? []) {
      if (e.school && !haystack.includes(normalizeForMatch(e.school))) missing.push(e.school);
    }

    if (missing.length) {
      checks.push({
        id: "ats_parse",
        severity: "error",
        message: `These did not survive text extraction and an ATS may not see them: ${missing.join(", ")}.`,
      });
    } else {
      checks.push({
        id: "ats_parse",
        severity: "ok",
        message: "Name, employers, and schools all extract cleanly as selectable text.",
      });
    }

    if (haystack.length < 400) {
      checks.push({
        id: "thin_text",
        severity: "warning",
        message: "Very little extractable text — the page may be too sparse.",
      });
    }
  } catch (err) {
    checks.push({
      id: "ats_parse",
      severity: "warning",
      message: `Could not re-parse the generated PDF to verify it: ${(err as Error).message}`,
    });
  }
  return checks;
}

export async function runAllChecks(
  pdfBytes: Uint8Array,
  doc: ResumeDoc,
  profile: StructuredProfile,
  layout: LayoutSpec,
): Promise<ResumeCheck[]> {
  return [...checkGrounding(doc, profile), ...checkWriting(doc), ...(await checkRenderedPdf(pdfBytes, doc, layout))];
}

// ---------------------------------------------------------------------------
// Stage 5 -- vision design review
// ---------------------------------------------------------------------------

export type DesignReview = {
  verdict: "good" | "needs_work";
  critique: string;
  layout_adjustments: Partial<LayoutSpec>;
  needs_content_revision: boolean;
  content_guidance: string;
};

const DESIGN_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["good", "needs_work"] },
    critique: {
      type: "string",
      description: "2-5 sentences on what specifically works and what does not, in plain language for the candidate.",
    },
    layout_adjustments: {
      type: "object",
      description: "Only include fields you actually want changed. Omit the rest.",
      properties: {
        font_scale: { type: "number", description: "0.88-1.14. Lower to fit more, raise if the page looks empty." },
        spacing: { type: "number", description: "0.78-1.3. Lower to tighten vertical whitespace, raise to open it up." },
        max_pages: { type: "number", description: "1 or 2." },
        show_summary: { type: "boolean", description: "False to reclaim the space the summary occupies." },
        skills_first: { type: "boolean", description: "True to move Skills above Experience." },
      },
    },
    needs_content_revision: {
      type: "boolean",
      description: "True only if the text itself must change (too long, too wordy, wrong emphasis), not just spacing.",
    },
    content_guidance: {
      type: "string",
      description: "If needs_content_revision, precise instructions for the writer. Otherwise empty string.",
    },
  },
  required: ["verdict", "critique", "layout_adjustments", "needs_content_revision", "content_guidance"],
} as const;

export async function reviewResumeDesign(
  env: ResumeEnv,
  provider: Provider,
  screenshotBase64: string,
  layout: LayoutSpec,
  checks: ResumeCheck[],
  userComment: string,
): Promise<DesignReview> {
  const problems = checks.filter((c) => c.severity !== "ok");
  const prompt = [
    "You are a professional resume designer reviewing the rendered page above. Judge it the way a recruiter",
    "would in a six-second skim, and the way a typographer would on a second look.",
    "",
    "Look specifically for: unbalanced or excessive whitespace; a page that runs slightly over and leaves an",
    "almost-empty second page; cramped or colliding text; inconsistent alignment of dates and headings;",
    "a weak visual hierarchy where the most important evidence does not draw the eye first; orphaned headings;",
    "and sections that are disproportionate to their importance (education dominating experience, for example).",
    "",
    "You may only adjust the layout knobs in the schema -- you cannot write CSS, and you should not try.",
    "If the real problem is that the writing is too long or emphasizes the wrong things, say so by setting",
    "needs_content_revision and giving precise content_guidance; a writer will rewrite from verified evidence.",
    "Do not ask for fabricated content. Do not request decorative elements, photos, icons, skill bars, or",
    "multi-column layouts -- those break applicant tracking system parsing.",
    "",
    // content_guidance is fed straight back into the compose step, so it has to follow the same
    // rules the resume itself does or it will reintroduce exactly what those rules strip out.
    WRITING_STYLE_RULES,
    "",
    `Current layout settings: ${JSON.stringify(layout)}`,
    problems.length
      ? `Automated checks already flagged:\n${problems.map((c) => `- [${c.severity}] ${c.message}`).join("\n")}`
      : "Automated checks all passed.",
    userComment ? `\nThe candidate specifically asked for:\n${userComment}\nTreat this as the priority.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const review = await callStructuredWithImage<DesignReview>(
    env,
    provider,
    "resume.design_review",
    prompt,
    screenshotBase64,
    DESIGN_REVIEW_SCHEMA,
    "submit_design_review",
    2000,
  );
  return {
    verdict: review.verdict === "good" ? "good" : "needs_work",
    critique: review.critique ?? "",
    layout_adjustments: review.layout_adjustments ?? {},
    needs_content_revision: Boolean(review.needs_content_revision),
    content_guidance: review.content_guidance ?? "",
  };
}

/** Applies a review's requested knobs on top of the current layout, re-clamping everything. */
export function applyLayoutAdjustments(layout: LayoutSpec, adjustments: Partial<LayoutSpec>): LayoutSpec {
  return normalizeLayout({ ...layout, ...adjustments, template: layout.template });
}
