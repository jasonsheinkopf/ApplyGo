// Company discovery and job-board scanning.
//
// Two deliberate choices here.
//
// First, no aggregators. Jobs come from each company's *own* job board. Nearly every company
// runs that board on one of a handful of applicant tracking systems, and those systems publish
// plain public JSON APIs for the board's contents. So "check their website directly" is done by
// resolving which ATS a company uses and reading its board API -- structured, stable, and far
// more reliable than scraping a JavaScript-rendered careers page.
//
// Second, the same model/code split as the resume pipeline: the LLM *proposes* companies from
// the candidate's profile, and code *verifies* them. A proposed company whose site does not
// resolve is marked unreachable rather than silently trusted, because a model listing plausible
// employers will occasionally invent or misremember one.

import { type LlmEnv, type Provider, WRITING_STYLE_RULES, callStructured } from "./llm";

export type AtsProvider = "greenhouse" | "lever" | "ashby" | "smartrecruiters";

export type CompanyProposal = {
  name: string;
  website: string;
  careers_url: string;
  bio: string;
  location: string;
  why_fit: string;
};

export type ScannedJob = {
  external_id: string;
  title: string;
  url: string;
  location: string;
  posted_at: string;
  description: string;
};

// ---------------------------------------------------------------------------
// Location constraints
// ---------------------------------------------------------------------------

const US_STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado",
  ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho",
  il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana",
  me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota",
  ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada",
  nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina",
  nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania",
  ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas",
  ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia",
  wi: "wisconsin", wy: "wyoming", dc: "district of columbia",
};

// Metro shorthand people actually type, mapped to the terms a company location would use.
const METRO_ALIASES: Record<string, string[]> = {
  "bay area": ["california", "san francisco", "san jose", "palo alto", "mountain view", "sunnyvale", "oakland", "berkeley", "santa clara", "menlo park", "cupertino", "redwood city", "san mateo"],
  "sf bay area": ["california", "san francisco", "san jose", "palo alto", "mountain view", "sunnyvale", "oakland", "santa clara", "menlo park", "cupertino"],
  "silicon valley": ["california", "san jose", "palo alto", "mountain view", "sunnyvale", "santa clara", "cupertino", "menlo park"],
  sf: ["san francisco", "california"],
  socal: ["california", "los angeles", "san diego", "irvine", "pasadena", "santa monica"],
  la: ["los angeles", "california"],
  nyc: ["new york"],
  "new york city": ["new york"],
  "the city": ["san francisco"],
  seattle: ["washington", "seattle", "bellevue", "redmond"],
  boston: ["massachusetts", "boston", "cambridge"],
  austin: ["texas", "austin"],
};

function normalizeLocationText(value: string): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Splits a free-text location preference into individual acceptable places. */
export function parseLocationFilter(text: string): string[] {
  return String(text ?? "")
    .split(/[,;\n]|\bor\b|\band\b|\//gi)
    .map((part) => normalizeLocationText(part))
    .filter((part) => part.length > 1);
}

/** Every spelling of a place we should accept: the term itself, plus state and metro expansions. */
function expandLocationTerm(term: string): string[] {
  const out = new Set<string>([term]);
  if (US_STATES[term]) out.add(US_STATES[term]);
  for (const [abbr, full] of Object.entries(US_STATES)) {
    if (full === term) out.add(abbr);
  }
  for (const alias of METRO_ALIASES[term] ?? []) out.add(alias);
  return Array.from(out);
}

/**
 * True when a company or posting sits in one of the requested places. Unconstrained and
 * unknown locations pass -- an empty location field should not silently drop a real result --
 * but a location that is stated and clearly elsewhere is rejected.
 */
export function locationMatches(location: string, terms: string[]): boolean {
  if (!terms.length) return true;
  const haystack = normalizeLocationText(location);
  if (!haystack) return true;
  if (/\b(remote|anywhere|distributed|global|worldwide)\b/.test(haystack)) return true;

  for (const term of terms) {
    for (const variant of expandLocationTerm(term)) {
      // Two-letter state codes must match as whole words, or "ca" hits "chicago".
      const pattern =
        variant.length <= 2
          ? new RegExp(`\\b${variant}\\b`)
          : new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      if (pattern.test(haystack)) return true;
    }
  }
  return false;
}

/** Collapses punctuation and legal suffixes so the same company isn't added twice. */
export function companyNameKey(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa|nv|holdings|group|technologies|technology|labs|the)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Best-effort hostname slug, used as a fallback guess at a company's board token. */
export function slugFromWebsite(website: string): string {
  try {
    const host = new URL(website).hostname.replace(/^www\./, "");
    return host.split(".")[0].toLowerCase();
  } catch {
    return "";
  }
}

function normalizeUrl(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const COMPANY_LIST_SCHEMA = {
  type: "object",
  properties: {
    companies: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The company's common name, without a legal suffix." },
          website: { type: "string", description: "Primary marketing site, e.g. https://example.com" },
          careers_url: { type: "string", description: "Careers or jobs page URL if you know it, else empty string." },
          bio: {
            type: "string",
            description: "2-3 sentences: what the company actually does, its scale, and its engineering character.",
          },
          location: { type: "string", description: "Headquarters as 'City, State/Country'." },
          why_fit: {
            type: "string",
            description: "One sentence tying this company to the candidate's specific evidence and target roles.",
          },
        },
        required: ["name", "website", "careers_url", "bio", "location", "why_fit"],
      },
    },
  },
  required: ["companies"],
} as const;

export async function proposeCompanies(
  env: LlmEnv,
  provider: Provider,
  profileJson: string,
  desiredRoles: string,
  existingNames: string[],
  count: number,
  focus: string,
  locations: string,
): Promise<CompanyProposal[]> {
  const prompt = [
    "You are helping a candidate build a target list of companies to watch for openings.",
    `Propose ${count} companies that genuinely fit the profile and target roles below.`,
    "",
    // The bio and why_fit strings are rendered straight into the Companies tab, so they get the
    // same treatment as everything else the candidate reads.
    WRITING_STYLE_RULES,
    "",
    locations
      ? [
          "LOCATION REQUIREMENT -- this is a hard constraint, not a preference:",
          `The candidate will only consider work in: ${locations}.`,
          "Every company you propose must be headquartered there, or have a substantial office there.",
          "Set `location` to that qualifying office, not to a headquarters somewhere else.",
          "A company that does not qualify must be left out entirely, even if it is otherwise a",
          "perfect fit. Returning fewer companies is correct; returning out-of-area ones is not.",
          "",
        ].join("\n")
      : "",
    "Rules:",
    "- Real, currently operating companies only. If you are not confident a company still exists",
    "  under that name, leave it out.",
    "- Give the real primary domain. Do not guess at a URL pattern you are unsure of; an empty",
    "  careers_url is much better than an invented one.",
    "- Favor companies where the candidate's specific evidence would actually be competitive, not",
    "  just famous names. A mix of sizes is more useful than ten household names.",
    "- Vary the list: do not return near-duplicates of each other.",
    focus ? `- The candidate specifically asked to focus on: ${focus}` : "",
    "",
    existingNames.length
      ? `ALREADY ON THE LIST -- do not propose any of these again:\n${existingNames.join(", ")}`
      : "The list is currently empty.",
    "",
    desiredRoles
      ? `TARGET ROLES (if these state a location or work arrangement, treat it as binding):\n${desiredRoles}`
      : "TARGET ROLES: not specified; infer from the profile.",
    "",
    `CANDIDATE PROFILE:\n${profileJson}`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await callStructured<{ companies: CompanyProposal[] }>(
    env,
    provider,
    prompt,
    COMPANY_LIST_SCHEMA,
    "submit_companies",
    4000,
  );

  return (result.companies ?? [])
    .map((c) => ({
      name: String(c.name ?? "").trim(),
      website: normalizeUrl(c.website ?? ""),
      careers_url: normalizeUrl(c.careers_url ?? ""),
      bio: String(c.bio ?? "").trim(),
      location: String(c.location ?? "").trim(),
      why_fit: String(c.why_fit ?? "").trim(),
    }))
    .filter((c) => c.name && c.website);
}

async function fetchWithTimeout(url: string, ms: number, init: RequestInit = {}): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "user-agent": "ApplyGo/1.0 (personal job search agent)", ...(init.headers ?? {}) },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Confirms a proposed company's site actually resolves, so hallucinated entries are flagged. */
export async function verifyWebsite(website: string): Promise<boolean> {
  const res = await fetchWithTimeout(website, 8000, { method: "GET", redirect: "follow" });
  return Boolean(res && res.status < 400);
}

// ---------------------------------------------------------------------------
// ATS board resolution
// ---------------------------------------------------------------------------

// Each company's careers page almost always links out to whichever ATS hosts the real board.
// Finding that link gives us the board token without guessing.
const ATS_PATTERNS: { provider: AtsProvider; pattern: RegExp }[] = [
  { provider: "greenhouse", pattern: /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i },
  { provider: "lever", pattern: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i },
  { provider: "ashby", pattern: /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i },
  { provider: "smartrecruiters", pattern: /careers\.smartrecruiters\.com\/([a-z0-9_-]+)/i },
];

const CAREERS_PATHS = ["/careers", "/jobs", "/careers/", "/about/careers", "/company/careers"];

function boardApiUrl(provider: AtsProvider, token: string): string {
  switch (provider) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
    case "lever":
      return `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`;
    case "smartrecruiters":
      return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=100`;
  }
}

/** Scrapes only for the ATS link itself -- never for job content, which comes from the board API. */
function detectAtsInHtml(html: string): { provider: AtsProvider; token: string } | null {
  for (const { provider, pattern } of ATS_PATTERNS) {
    const match = html.match(pattern);
    if (match?.[1]) return { provider, token: match[1] };
  }
  return null;
}

export type BoardResolution = { provider: AtsProvider; token: string } | null;

/**
 * Resolves a company's job board: read the careers page for an ATS link first, and if that finds
 * nothing, try the company's own slug as a token against each provider. The slug guess is cheap
 * and correct surprisingly often, because most companies register their own name on their ATS.
 */
export async function resolveBoard(
  website: string,
  careersUrl: string,
  budget: { remaining: number },
): Promise<BoardResolution> {
  const pages = [careersUrl, ...CAREERS_PATHS.map((p) => safeJoin(website, p))].filter(Boolean);
  const seen = new Set<string>();

  for (const page of pages) {
    if (budget.remaining <= 0) return null;
    if (seen.has(page)) continue;
    seen.add(page);
    budget.remaining -= 1;
    const res = await fetchWithTimeout(page, 8000, { redirect: "follow" });
    if (!res || !res.ok) continue;
    const html = await res.text().catch(() => "");
    if (!html) continue;
    const found = detectAtsInHtml(html);
    if (found) return found;
    // Some careers pages are a thin redirect shell; the final URL itself may be the board.
    const fromFinalUrl = detectAtsInHtml(res.url);
    if (fromFinalUrl) return fromFinalUrl;
  }

  const slug = slugFromWebsite(website);
  if (!slug) return null;
  for (const provider of ["greenhouse", "lever", "ashby"] as AtsProvider[]) {
    if (budget.remaining <= 0) return null;
    budget.remaining -= 1;
    const res = await fetchWithTimeout(boardApiUrl(provider, slug), 8000);
    if (res && res.ok) {
      const body = await res.text().catch(() => "");
      if (body && body.trim() !== "[]" && !body.includes('"jobs":[]')) return { provider, token: slug };
    }
  }
  return null;
}

function safeJoin(base: string, path: string): string {
  try {
    return new URL(path, base).toString();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Board reading
// ---------------------------------------------------------------------------

function stripHtml(value: string): string {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Each provider's response is parsed defensively -- these are third-party shapes that can change,
 * and a company with one odd field should degrade to a thinner posting rather than fail the scan.
 *
 * DESCRIPTION_CAP bounds each posting's plain-text length right here, at the source -- this is the
 * actual ceiling on what any later stage (storage, tier-2 scoring) can ever work with, no matter
 * what those stages' own caps allow. A real single-role posting -- intro, responsibilities,
 * requirements, preferred quals, an "about the company" paragraph, and a compensation/benefits
 * section -- routinely runs several thousand characters once you count all of that, and the
 * compensation section in particular tends to sit near the very end. 8000 is chosen generously: no
 * aggregator pages are ever scanned (see companies.ts's own docs), so there's no risk of an
 * unbounded multi-listing payload landing here, just an occasional long single posting.
 */
const DESCRIPTION_CAP = 8000;

export async function fetchBoardJobs(provider: AtsProvider, token: string): Promise<ScannedJob[]> {
  const res = await fetchWithTimeout(boardApiUrl(provider, token), 12000);
  if (!res || !res.ok) throw new Error(`board_http_${res ? res.status : "unreachable"}`);
  const data = (await res.json().catch(() => null)) as unknown;
  if (!data) throw new Error("board_bad_json");

  const asArray = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  const str = (value: unknown): string => (typeof value === "string" ? value : "");

  if (provider === "greenhouse") {
    const jobs = asArray((data as { jobs?: unknown }).jobs);
    return jobs.map((j) => ({
      external_id: String(j.id ?? ""),
      title: str(j.title),
      url: str(j.absolute_url),
      location: str((j.location as { name?: string } | undefined)?.name),
      posted_at: str(j.updated_at),
      description: stripHtml(str(j.content)).slice(0, DESCRIPTION_CAP),
    }));
  }

  if (provider === "lever") {
    return asArray(data).map((j) => ({
      external_id: str(j.id),
      title: str(j.text),
      url: str(j.hostedUrl),
      location: str((j.categories as { location?: string } | undefined)?.location),
      posted_at: j.createdAt ? new Date(Number(j.createdAt)).toISOString() : "",
      description: (str(j.descriptionPlain) || stripHtml(str(j.description))).slice(0, DESCRIPTION_CAP),
    }));
  }

  if (provider === "ashby") {
    const jobs = asArray((data as { jobs?: unknown }).jobs);
    return jobs.map((j) => ({
      external_id: str(j.id),
      title: str(j.title),
      url: str(j.jobUrl) || str(j.applyUrl),
      location: str(j.location),
      posted_at: str(j.publishedAt),
      description: (str(j.descriptionPlain) || stripHtml(str(j.descriptionHtml))).slice(0, DESCRIPTION_CAP),
    }));
  }

  const content = asArray((data as { content?: unknown }).content);
  return content.map((j) => {
    const loc = (j.location ?? {}) as { city?: string; region?: string; country?: string };
    return {
      external_id: str(j.id),
      title: str(j.name),
      url: `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${encodeURIComponent(str(j.id))}`,
      location: [loc.city, loc.region, loc.country].filter(Boolean).join(", "),
      posted_at: str(j.releasedDate),
      description: "",
    };
  });
}

/** Keeps obviously irrelevant postings out of the Jobs tab without needing a model call. */
export function filterJobsByRoles(jobs: ScannedJob[], desiredRoles: string): ScannedJob[] {
  const terms = Array.from(
    new Set(
      String(desiredRoles ?? "")
        .toLowerCase()
        .match(/[a-z][a-z+#.]{2,}/g) ?? [],
    ),
  ).filter((t) => !STOPWORDS.has(t));
  if (terms.length < 3) return jobs;
  return jobs.filter((job) => {
    const title = job.title.toLowerCase();
    return terms.some((term) => title.includes(term));
  });
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "are", "was", "were", "you",
  "your", "their", "they", "would", "could", "should", "like", "want", "looking", "role", "roles",
  "job", "jobs", "work", "working", "company", "companies", "team", "teams", "years", "year",
  "experience", "candidate", "position", "positions", "opportunity", "opportunities", "where",
  "which", "into", "about", "more", "most", "also", "such", "than", "then", "some", "any", "can",
]);
