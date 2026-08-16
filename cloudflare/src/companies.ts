// Company discovery, ATS resolution, and job-board scanning. Entirely deterministic, on purpose.
//
// No aggregators *for job data*. Every posting a candidate actually sees comes from a company's
// *own* job board, never a third party. Nearly every company runs that board on one of a handful of
// applicant tracking systems, and those systems publish plain public JSON APIs for the board's
// contents. So "check their website directly" is done by resolving which ATS a company uses and
// reading its board API -- structured, stable, and far more reliable than scraping a
// JavaScript-rendered careers page. Company *discovery* is a separate concern from this, and does
// draw on a real job-market aggregator (Adzuna, see src/adzuna.ts) -- see that file's header for why
// that doesn't weaken this principle.
//
// There is no LLM anywhere in this file, and deliberately so. A company is monitored because a real
// job search found it and its board can actually be read -- never because a model judged its
// industry "relevant" to the candidate. A non-tech company that occasionally hires the candidate's
// target role is exactly as worth monitoring as a company whose whole business matches it; that
// judgment belongs at the job level (fit.ts), never at the company level. Wherever this file has to
// guess something (an ATS org slug in resolveBoard, a domain in resolveCompanyDomain), the guess is
// always confirmed by a real request before it's trusted -- never taken on a model's word.

// Every ATS this app recognizes on a careers page, whether or not it can actually read job
// listings from it. Recognizing a platform is worth doing even without a read path: it's the
// difference between telling a candidate "no job board found" (implying there's nothing to see)
// and "this company hires through ADP -- here's the link" (true, and actionable).
export type AtsProvider =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "workday"
  | "adp"
  | "icims"
  | "bamboohr"
  | "workable"
  | "recruitee"
  | "jazzhr"
  | "breezy"
  | "personio"
  | "paylocity"
  | "ukg"
  | "successfactors"
  | "taleo"
  | "jobvite";

/**
 * Providers this app can read structured job listings from. Workable, Recruitee, and BambooHR
 * joined the original five after each was checked against real, live companies (not assumed from
 * a vendor's docs) and confirmed to publish an unauthenticated JSON endpoint with real job data.
 * The other ten are still worth *detecting* -- see the type comment above -- but each was checked
 * the same way and found to have no equivalent path; see the comment on ATS_PATTERNS for the
 * specific reason per provider. A detected-but-unreadable company gets a working link to its board
 * instead, via ATS_DISPLAY_NAMES and the isReadableAtsProvider check below.
 */
const READABLE_ATS_PROVIDERS = new Set<AtsProvider>([
  "greenhouse", "lever", "ashby", "smartrecruiters", "workday", "workable", "recruitee", "bamboohr",
]);

export function isReadableAtsProvider(provider: AtsProvider): boolean {
  return READABLE_ATS_PROVIDERS.has(provider);
}

const ATS_DISPLAY_NAMES: Record<AtsProvider, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  smartrecruiters: "SmartRecruiters",
  workday: "Workday",
  adp: "ADP",
  icims: "iCIMS",
  bamboohr: "BambooHR",
  workable: "Workable",
  recruitee: "Recruitee",
  jazzhr: "JazzHR",
  breezy: "Breezy",
  personio: "Personio",
  paylocity: "Paylocity",
  ukg: "UKG/UltiPro",
  successfactors: "SAP SuccessFactors",
  taleo: "Oracle Taleo",
  jobvite: "Jobvite",
};

export function atsDisplayName(provider: AtsProvider): string {
  return ATS_DISPLAY_NAMES[provider] ?? provider;
}

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
  socal: ["california", "los angeles", "san diego", "irvine", "pasadena", "santa monica", "orange county", "anaheim", "santa ana", "long beach"],
  "southern california": ["california", "los angeles", "san diego", "irvine", "pasadena", "santa monica", "orange county", "anaheim", "santa ana", "long beach"],
  "orange county": ["california", "irvine", "anaheim", "santa ana", "costa mesa", "newport beach", "huntington beach", "orange"],
  "northern california": ["california", "san francisco", "san jose", "oakland", "sacramento", "berkeley"],
  "north california": ["california", "san francisco", "san jose", "oakland", "sacramento", "berkeley"],
  norcal: ["california", "san francisco", "san jose", "oakland", "sacramento", "berkeley"],
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

// People listing acceptable-but-not-required places naturally tack on a qualifier -- "Orange
// County preferred", "North California also" -- that isn't part of the place name. Left in, it
// turns a real, matchable place into a literal string no company's address will ever contain,
// silently rejecting every proposal from that term instead of just weighting it any differently
// (this doesn't affect ranking today; it only prevents a real place from becoming unmatchable).
const TRAILING_QUALIFIER = /\s+(preferred|ideally|especially|also|fine|ok|okay|too)$/;

/** Splits a free-text location preference into individual acceptable places. */
export function parseLocationFilter(text: string): string[] {
  return String(text ?? "")
    .split(/[,;\n]|\bor\b|\band\b|\//gi)
    .map((part) => normalizeLocationText(part).replace(TRAILING_QUALIFIER, "").trim())
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

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export async function fetchWithTimeout(url: string, ms: number, init: RequestInit = {}): Promise<Response | null> {
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

/**
 * Confirms a proposed company's site actually resolves, so a hallucinated or defunct entry never
 * gets added at all -- see discoverCompanies in index.ts, which now skips a company outright
 * rather than adding it flagged "unreachable". Getting this right in both directions matters: a
 * company whose domain genuinely doesn't resolve (out of business, DNS gone) should never appear,
 * but a company whose site blocks scrapers with a 401/403 is still very much alive and shouldn't
 * be punished for having a bot-blocking WAF in front of an otherwise ordinary website.
 */
export async function verifyWebsite(website: string): Promise<boolean> {
  const res = await fetchWithTimeout(website, 8000, { method: "GET", redirect: "follow" });
  // No response at all means the domain didn't resolve, the connection was refused, or it timed
  // out -- a genuinely dead site, not a picky one.
  if (!res) return false;
  if (res.status === 401 || res.status === 403) return true;
  return res.status < 400;
}

// ---------------------------------------------------------------------------
// ATS board resolution
// ---------------------------------------------------------------------------

// Each company's careers page almost always links out to whichever ATS hosts the real board.
// Finding that link gives us the board token without guessing.
//
// Split into two groups. The first eight are READABLE_ATS_PROVIDERS -- their capture group is the
// org slug boardApiUrl needs to build a listing request. The rest are detect-only: their capture
// group is the whole host+path fragment the link pointed at (no scheme), stored as the token
// as-is and turned straight into a clickable `https://` URL by the caller, since there's no API
// to build a request against. Workday's capture spans tenant+pod+site together (its careers link
// is one hostname, not a bare org slug) and gets split apart by parseWorkdayToken below.
const ATS_PATTERNS: { provider: AtsProvider; pattern: RegExp }[] = [
  { provider: "greenhouse", pattern: /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i },
  // A careers page that renders its board client-side often still names the org slug in an inline
  // script that calls the API domain directly, rather than linking to the public board page at all
  // -- e.g. anduril.com's careers page never links boards.greenhouse.io anywhere in its HTML, but
  // does reference boards-api.greenhouse.io for its own embedded widget to call.
  { provider: "greenhouse", pattern: /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i },
  { provider: "lever", pattern: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i },
  { provider: "ashby", pattern: /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i },
  { provider: "smartrecruiters", pattern: /careers\.smartrecruiters\.com\/([a-z0-9_-]+)/i },
  { provider: "workday", pattern: /([a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?[a-zA-Z0-9_.-]+)/i },

  // These three were investigated and confirmed to have a real, live, unauthenticated JSON API --
  // verified against 9 real companies (3 each) during that investigation, not assumed from a
  // vendor's own marketing claim. Their capture groups pull out just the account slug the API
  // needs, matching the five above rather than the detect-only group below.
  { provider: "workable", pattern: /apply\.workable\.com\/([a-z0-9_-]+)/i },
  { provider: "recruitee", pattern: /([a-z0-9-]+)\.recruitee\.com/i },
  { provider: "bamboohr", pattern: /([a-z0-9-]+)\.bamboohr\.com\/(?:jobs|careers)/i },

  // Detect-only: recognized so a company using one of these reads as "found, here's the link"
  // instead of "no supported job board" -- not read automatically. Each of these ten was checked
  // for a real public API during the same investigation that added the three above, live against
  // real companies wherever a plausible endpoint existed, rather than assumed:
  //   adp, icims          -- career-site HTML is client-rendered from an internal call this
  //                          investigation could not locate; the official API is customer-gated.
  //   jazzhr, jobvite      -- native API is real but strictly per-customer-key or opt-in-per-
  //                          customer-and-usually-off; no public multi-tenant path exists.
  //   breezy               -- official API requires a bearer token; no working public path found.
  //   paylocity            -- has a "documented-looking" public feed API, and it responds 200 with
  //                          well-formed JSON -- but it returned an empty jobs array for every one
  //                          of 5 real, currently-recruiting companies tested. That is the exact
  //                          failure mode this file's header warns about (looks like it works,
  //                          silently returns nothing), so it stays unread rather than shipped on
  //                          a guess a live test could not actually confirm.
  //   personio             -- has a real, confirmed-live, unauthenticated feed (verified against
  //                          a real company's postings) -- but it's XML, and every reader in this
  //                          file is a JSON.parse. Adding an XML posting format is a real, scoped
  //                          piece of follow-up work, not a dead end like the others below.
  //   ukg, successfactors, taleo -- each has some public-but-undocumented surface (an XML sitemap,
  //                          an OData call, a searchjobs endpoint), but every one needs a company-
  //                          specific ID discovered by a step beyond regex extraction from a
  //                          careers page (a data-center-specific host, a portal ID, a company
  //                          code) -- a real gap, not a "didn't get to it yet".
  { provider: "adp", pattern: /((?:workforcenow|recruiting|jobs)\.adp\.com\/[^\s"'<>]+)/i },
  { provider: "icims", pattern: /([a-z0-9-]+\.icims\.com\/(?:jobs|careers)[^\s"'<>]*)/i },
  { provider: "jazzhr", pattern: /([a-z0-9-]+\.applytojob\.com[^\s"'<>]*)/i },
  { provider: "breezy", pattern: /([a-z0-9-]+\.breezy\.hr[^\s"'<>]*)/i },
  { provider: "personio", pattern: /([a-z0-9-]+\.(?:jobs\.)?personio\.(?:de|com)[^\s"'<>]*)/i },
  { provider: "paylocity", pattern: /(recruiting\.paylocity\.com\/recruiting\/jobs[^\s"'<>]*)/i },
  { provider: "ukg", pattern: /(recruiting2?\.ultipro\.com[^\s"'<>]*)/i },
  { provider: "successfactors", pattern: /([a-z0-9-]+\.(?:career\d*\.)?successfactors\.(?:com|eu)[^\s"'<>]*)/i },
  { provider: "taleo", pattern: /([a-z0-9-]+\.taleo\.net[^\s"'<>]*)/i },
  { provider: "jobvite", pattern: /(jobs\.jobvite\.com\/[a-z0-9-]+[^\s"'<>]*)/i },
];

const CAREERS_PATHS = [
  "/careers", "/jobs", "/careers/", "/about/careers", "/company/careers",
  "/open-roles", "/join-us", "/join", "/work-with-us", "/positions",
];

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
    case "workable":
      // Workable's own embeddable-widget endpoint -- public and unauthenticated by design, since
      // Workable's own product uses it to power customer career pages. details=true includes each
      // job's full HTML description inline, so no per-posting follow-up fetch is needed.
      return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}?details=true`;
    case "recruitee":
      // Documented at docs.recruitee.com/reference/offers-get. Includes full description inline.
      return `https://${encodeURIComponent(token)}.recruitee.com/api/offers/`;
    case "bamboohr":
      // Unlike the other two added alongside it, this list endpoint is thin -- no description, no
      // posting URL, no date -- so bamboohr also needs the per-posting detail fetch in
      // fetchMissingDescriptions below, the same shape smartrecruiters already uses.
      return `https://${encodeURIComponent(token)}.bamboohr.com/careers/list`;
    default:
      // Workday builds its own request (POST, paginated -- see fetchWorkdayJobs) and every
      // detect-only provider is never read at all, so neither ever reaches this function. Reaching
      // it anyway is a caller bug, not a live-traffic path.
      throw new Error(`no_board_api_url_for_${provider}`);
  }
}

/** Splits a matched Workday careers-link fragment into the three pieces its CXS API needs. */
function parseWorkdayToken(raw: string): { tenant: string; pod: string; site: string } | null {
  const match = raw.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([a-zA-Z0-9_.-]+)/i);
  if (!match) return null;
  return { tenant: match[1], pod: match[2], site: match[3] };
}

/** Scrapes only for the ATS link itself -- never for job content, which comes from the board API. */
function detectAtsInHtml(html: string): { provider: AtsProvider; token: string } | null {
  for (const { provider, pattern } of ATS_PATTERNS) {
    const match = html.match(pattern);
    if (!match?.[1]) continue;
    if (provider === "workday") {
      const parsed = parseWorkdayToken(match[1]);
      if (!parsed) continue;
      return { provider, token: `${parsed.tenant}|${parsed.pod}|${parsed.site}` };
    }
    return { provider, token: match[1] };
  }
  return null;
}

/**
 * Detects an ATS directly from a URL, rather than from a page's HTML.
 *
 * The same ATS_PATTERNS apply -- a board URL contains the provider's own hostname by definition --
 * but nothing used to run them against a URL we had *already resolved and stored*. That gap is
 * visible in the live database: "General Matter" sits at ats_provider='none', job source "no board
 * found", with `https://job-boards.greenhouse.io/generalmatter` stored on the very same row. Its
 * jobs are readable right now and were never imported, and the row displays a board link beside
 * the words "no job board" -- the contradiction reported from the UI.
 *
 * Cheap and offline: pure pattern matching on a string, no request. Worth running on any careers
 * or board URL, however it was obtained (redirect target, manual entry, prior scan).
 */
export function detectAtsFromUrl(url: string): { provider: AtsProvider; token: string } | null {
  if (!url) return null;
  return detectAtsInHtml(url);
}

export type BoardResolution = { provider: AtsProvider; token: string } | null;

/**
 * A handful of plausible ATS org slugs derived from the company's display name, since a company
 * as often registers its full name as its bare domain label -- Anduril Industries' actual
 * Greenhouse slug is "andurilindustries", which `slugFromWebsite("anduril.com")` ("anduril") never
 * produces. Deduplicated by the caller against the domain-derived guess.
 */
export function slugsFromName(name: string): string[] {
  const words = String(name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  return Array.from(new Set([words.join(""), words.join("-")])).filter((s) => s.length > 1);
}

/**
 * SmartRecruiters is the one provider of the four that answers 200 for an org slug that doesn't
 * exist at all (an empty result set), rather than 404 like the other three -- res.ok already rules
 * those out, so this only has to cover SmartRecruiters' case, and it also means a real org with
 * zero current openings reads the same as "not found" here. That's an acceptable miss: a company
 * with nothing open isn't useful to register a guessed token for anyway.
 */
function boardHasListings(provider: AtsProvider, body: string): boolean {
  if (provider === "smartrecruiters") return !body.includes('"totalFound":0');
  return body.trim() !== "[]" && !body.includes('"jobs":[]');
}

/**
 * Resolves a company's job board: read the careers page for an ATS link first, and if that finds
 * nothing, try plausible org slugs (from the domain and from the company's name) against every
 * provider. The slug guess is cheap and correct surprisingly often, because most companies
 * register either their bare domain name or their full display name as their ATS token -- and it's
 * the only thing that can work at all for a careers page that renders its board client-side, since
 * the real link then never appears in the static HTML this fetches to begin with.
 */
function safeJoin(base: string, path: string): string {
  try {
    return new URL(path, base).toString();
  } catch {
    return "";
  }
}

// Words that show up in a real "go see our openings" link, in either the href path or the
// anchor's own visible text -- a link reading "Join our team" whose href is just "/careers"
// matches on text; a link whose visible text is a translated or icon-only label but whose href is
// "/en/careers/open-positions" matches on href. Checking both is what catches a link the blind
// CAREERS_PATHS guesses below would miss because the real path isn't one of the common ones.
const CAREERS_LINK_HINTS = /career|jobs?|opening|position|hiring|join[- ]?(?:us|our)|work[- ]?(?:with|for)[- ]?us|employment/i;

/**
 * Pulls every plausible "careers" link off a page (typically the homepage) and ranks them so the
 * strongest candidates -- hinted in both the href and the visible link text -- are tried first.
 *
 * This is what makes finding a company's board work the way a person actually does it: open the
 * homepage, find the button that says "Careers", click it, see where it goes -- rather than only
 * ever trying a fixed list of guessed URL paths. It also means a careers page that hands off
 * straight to a third-party ATS (an "you are now leaving our site" interstitial, or just a direct
 * link to a WorkForceNow/iCIMS/etc. board) gets followed and read for an ATS pattern the same way
 * any other page does, instead of the guesswork never reaching it at all.
 */
function extractCareersLinks(html: string, baseUrl: string): string[] {
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const candidates: { url: string; score: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html))) {
    const href = match[1];
    if (/^(mailto|tel|javascript):/i.test(href)) continue;
    const text = htmlToText(match[2]);
    const hrefHints = CAREERS_LINK_HINTS.test(href);
    const textHints = CAREERS_LINK_HINTS.test(text);
    if (!hrefHints && !textHints) continue;
    const absolute = safeJoin(baseUrl, href);
    if (!absolute) continue;
    candidates.push({ url: absolute, score: (hrefHints ? 1 : 0) + (textHints ? 1 : 0) });
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.score - a.score)
    .map((c) => c.url)
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

/**
 * Resolves a company's job board. Order of attempts, cheapest and most-likely-correct first:
 *
 * 1. Read the homepage itself -- it's fetched anyway to find a careers link (step 2), so checking
 *    it directly for an ATS pattern first is free, and catches the case where the ATS link (or
 *    even the board itself) is right there on the front page with no separate careers page at all.
 * 2. Follow the LLM-proposed careers URL, then whichever links on the homepage actually look like
 *    "go see our openings" (see extractCareersLinks) -- a real link the site publishes, which is
 *    far more likely to land on the right page than a blind guess.
 * 3. Fall back to a fixed list of common careers paths, for sites whose real link this missed.
 * 4. Last resort: guess plausible org slugs (from the domain and the company's name) against every
 *    provider with a public API, for a careers page that renders its board client-side and never
 *    puts the real link in the static HTML at all.
 */
export async function resolveBoard(
  website: string,
  careersUrl: string,
  name: string,
  budget: { remaining: number },
): Promise<BoardResolution> {
  const seen = new Set<string>();

  async function tryPage(page: string): Promise<{ found: BoardResolution; html: string } | null> {
    if (!page || seen.has(page) || budget.remaining <= 0) return null;
    seen.add(page);
    budget.remaining -= 1;
    const res = await fetchWithTimeout(page, 8000, { redirect: "follow" });
    if (!res || !res.ok) return null;
    const html = await res.text().catch(() => "");
    if (!html) return null;
    // Some careers pages are a thin redirect shell; the final URL itself may be the board.
    const found = detectAtsInHtml(html) ?? detectAtsInHtml(res.url);
    return { found, html };
  }

  const home = await tryPage(website);
  if (home?.found) return home.found;

  const discoveredLinks = home?.html ? extractCareersLinks(home.html, website) : [];
  const pages = [careersUrl, ...discoveredLinks, ...CAREERS_PATHS.map((p) => safeJoin(website, p))].filter(Boolean);

  for (const page of pages) {
    const result = await tryPage(page);
    if (result?.found) return result.found;
  }

  // Workable's empty-account response (`{"jobs":[]}`) already matches boardHasListings' generic
  // fallback check, so it's safe to guess here too. Recruitee and BambooHR are deliberately left
  // out: their empty markers are `"offers":[]` and `"result":[]` respectively, which that same
  // generic check does not recognize, so a wrong guess against either would misread as a real hit
  // instead of correctly failing closed. Steps 1-3 above (a real link the company's own site
  // publishes) already read both providers correctly; only this last-resort blind guess is
  // narrowed until boardHasListings gets a per-provider case for them rather than one guessed at
  // under time pressure.
  const slugs = Array.from(new Set([slugFromWebsite(website), ...slugsFromName(name)].filter(Boolean)));
  for (const slug of slugs) {
    for (const provider of ["greenhouse", "lever", "ashby", "smartrecruiters", "workable"] as AtsProvider[]) {
      if (budget.remaining <= 0) return null;
      budget.remaining -= 1;
      const res = await fetchWithTimeout(boardApiUrl(provider, slug), 8000);
      if (res && res.ok) {
        const body = await res.text().catch(() => "");
        if (body && boardHasListings(provider, body)) return { provider, token: slug };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Domain resolution
// ---------------------------------------------------------------------------

// Tried in this order because a company more often registers the plainer, shorter-TLD domain --
// trying .com first keeps the common case to a single request.
const DOMAIN_GUESS_TLDS = ["com", "io", "ai"];

/**
 * Guesses a company's real website from its bare name, confirming every guess with verifyWebsite()
 * before returning it -- the same "propose a candidate, code confirms it" split this file already
 * uses for ATS resolution (resolveBoard's own slug-guessing step, one level down, guesses org
 * tokens the same way). Deliberately never falls back to an LLM: an unconfirmed guess here is worse
 * than none, since a wrong domain would go on to resolveBoard and could resolve to some *other*
 * company's real ATS board entirely. Returns null rather than inventing anything when nothing
 * verifies -- see discoverCompanies in index.ts, which records that company as 'unresolved' instead
 * of dropping it, so a human can supply the real website later.
 */
export async function resolveCompanyDomain(name: string): Promise<string | null> {
  for (const slug of slugsFromName(name)) {
    for (const tld of DOMAIN_GUESS_TLDS) {
      const candidate = `https://${slug}.${tld}`;
      if (await verifyWebsite(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Board reading
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'",
  rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', mdash: "-", ndash: "-", hellip: "...",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * HTML (or entity-escaped HTML) to readable plain text.
 *
 * **Decoding has to happen before tag-stripping, not after.** Greenhouse's board API returns each
 * posting's `content` entity-escaped (`&lt;p&gt;` rather than `<p>`), so stripping tags first is a
 * no-op on it -- and then decoding turns every `&lt;`/`&gt;` into a literal angle bracket, leaving
 * the markup behind as visible text. The stored description ends up padded with `<p>`, `<strong>`,
 * `</div>` noise that crowds out real content against the length cap and buries the sentences the
 * scoring pass is actually looking for. Decoding twice (before and after the strip) covers content
 * that was double-escaped, which is common for `&amp;` inside an already-escaped document.
 *
 * Block-level tags become newlines rather than spaces so a heading stays attached to what follows
 * it ("Base Salary Range:\n$199,000 - $331,000") instead of dissolving into one long run-on line.
 */
export function htmlToText(value: string): string {
  const decoded = decodeEntities(String(value ?? ""));
  const withBreaks = decoded
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|tr|h[1-6]|section|ul|ol|table|blockquote)\s*>/gi, "\n");
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Builds one posting's description from every text-bearing section the board exposes, in order.
 *
 * Providers do not put a whole posting in one field, and picking a single "the description" field
 * per provider is what silently loses the parts a candidate most wants (see the Lever branch
 * below). Empty or missing sections drop out rather than leaving blank gaps, so a provider that
 * renames or removes a field degrades to a thinner posting instead of an empty one.
 */
function joinSections(parts: (string | undefined)[]): string {
  return parts
    .map((part) => htmlToText(part ?? ""))
    .filter(Boolean)
    .join("\n\n")
    .slice(0, DESCRIPTION_CAP);
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

/**
 * Workday's CXS API is POST-with-a-body and paginated, unlike the other four providers' plain
 * GET-a-URL shape -- see fetchBoardJobs, which branches to this before ever calling boardApiUrl.
 * `token` is the `tenant|pod|site` string parseWorkdayToken produced when the board was resolved.
 *
 * Capped at MAX_WORKDAY_PAGES pages of listings: a huge board shouldn't spend the whole scan
 * budget on titles and locations alone when the descriptions fetched afterward (fetchMissingDescriptions,
 * only for postings that survive filtering) are the expensive part per posting.
 */
const MAX_WORKDAY_PAGES = 10;
const WORKDAY_PAGE_SIZE = 20;

async function fetchWorkdayJobs(tenant: string, pod: string, site: string): Promise<ScannedJob[]> {
  const base = `https://${tenant}.${pod}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
  const jobs: ScannedJob[] = [];

  for (let page = 0; page < MAX_WORKDAY_PAGES; page++) {
    const offset = page * WORKDAY_PAGE_SIZE;
    const res = await fetchWithTimeout(`${base}/jobs`, 12000, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset, searchText: "" }),
    });
    if (!res || !res.ok) {
      if (page === 0) throw new Error(`board_http_${res ? res.status : "unreachable"}`);
      break;
    }
    const data = (await res.json().catch(() => null)) as {
      total?: number;
      jobPostings?: { title?: string; externalPath?: string; locationsText?: string }[];
    } | null;
    if (page === 0 && !data) throw new Error("board_bad_json");
    const postings = data?.jobPostings ?? [];
    if (!postings.length) break;

    for (const posting of postings) {
      const externalPath = posting.externalPath ?? "";
      jobs.push({
        // externalPath (e.g. "/job/.../R-12345") is unique per posting and doubles as the id
        // fetchMissingDescriptions uses to build the detail-endpoint URL below.
        external_id: externalPath,
        title: String(posting.title ?? ""),
        url: externalPath ? `https://${tenant}.${pod}.myworkdayjobs.com/${site}${externalPath}` : "",
        location: String(posting.locationsText ?? ""),
        // Workday's listing only gives a relative phrase ("Posted 3 Days Ago"), not a real
        // timestamp -- left blank rather than guessed at, same rule DESCRIPTION_CAP's neighbors
        // already follow for any field a provider doesn't actually publish.
        posted_at: "",
        description: "",
      });
    }
    if (typeof data?.total === "number" && offset + postings.length >= data.total) break;
  }

  return jobs;
}

export async function fetchBoardJobs(provider: AtsProvider, token: string): Promise<ScannedJob[]> {
  if (provider === "workday") {
    const [tenant, pod, site] = token.split("|");
    if (!tenant || !pod || !site) throw new Error("board_bad_token");
    return fetchWorkdayJobs(tenant, pod, site);
  }

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
      // Greenhouse does put the whole posting in one field -- but entity-escaped, which is what
      // htmlToText's decode-before-strip ordering exists for.
      description: joinSections([str(j.content)]),
    }));
  }

  if (provider === "lever") {
    return asArray(data).map((j) => {
      // Lever splits a posting across several fields, and `description` is only the opening
      // paragraph. The responsibilities and requirements bullets live in `lists[]`, and the
      // closing block -- which is where a Lever posting almost always states compensation --
      // lives in `additional`. Reading `description` alone captured the intro and threw the rest
      // of the posting away, so salary and years-of-experience were never in the text the scoring
      // pass saw, and it correctly reported them as not specified.
      const lists = asArray(j.lists).map((list) => {
        const heading = str(list.text);
        const body = str(list.content);
        return heading ? `${heading}:\n${body}` : body;
      });
      return {
        external_id: str(j.id),
        title: str(j.text),
        url: str(j.hostedUrl),
        location: str((j.categories as { location?: string } | undefined)?.location),
        posted_at: j.createdAt ? new Date(Number(j.createdAt)).toISOString() : "",
        description: joinSections([
          str(j.descriptionPlain) || str(j.description),
          ...lists,
          str(j.additionalPlain) || str(j.additional),
        ]),
      };
    });
  }

  if (provider === "ashby") {
    const jobs = asArray((data as { jobs?: unknown }).jobs);
    return jobs.map((j) => {
      // Ashby exposes a pay range separately from the description on boards that publish one,
      // rather than only inside the prose, so it's picked up explicitly when present.
      const compensation = str(j.compensationTierSummary);
      return {
        external_id: str(j.id),
        title: str(j.title),
        url: str(j.jobUrl) || str(j.applyUrl),
        location: str(j.location),
        posted_at: str(j.publishedAt),
        description: joinSections([
          str(j.descriptionPlain) || str(j.descriptionHtml),
          compensation ? `Compensation: ${compensation}` : "",
        ]),
      };
    });
  }

  if (provider === "workable") {
    const jobs = asArray((data as { jobs?: unknown }).jobs);
    return jobs.map((j) => {
      const locations = asArray(j.locations);
      const first = (locations[0] ?? {}) as { city?: string; region?: string; country?: string };
      const location = [str(j.city) || first.city, str(j.state) || first.region, str(j.country) || first.country]
        .filter(Boolean)
        .join(", ");
      return {
        external_id: str(j.shortcode),
        title: str(j.title),
        url: str(j.url) || str(j.shortlink),
        location,
        posted_at: str(j.published_on) || str(j.created_at),
        description: joinSections([str(j.description)]),
      };
    });
  }

  if (provider === "recruitee") {
    const offers = asArray((data as { offers?: unknown }).offers);
    return offers.map((j) => ({
      // Recruitee's `id` is a number, not a string (confirmed against a real response) -- str()
      // only accepts strings by design, so a numeric id has to be coerced explicitly rather than
      // silently falling through to guid every time, which is what plain str(j.id) did here before.
      external_id: j.id !== undefined && j.id !== null ? String(j.id) : str(j.guid),
      title: str(j.title),
      url: str(j.careers_apply_url) || str(j.careers_url),
      // Recruitee already publishes a ready-made display string here, unlike most providers.
      location: str(j.location),
      posted_at: str(j.published_at) || str(j.created_at),
      description: joinSections([str(j.description)]),
    }));
  }

  if (provider === "bamboohr") {
    // Thin list: id, title, department, and a location object only -- no description, URL, or
    // date. fetchMissingDescriptions below fills in the rest from the per-posting detail endpoint,
    // same shape SmartRecruiters already needs.
    const jobs = asArray((data as { result?: unknown }).result);
    return jobs.map((j) => {
      const loc = (j.location ?? {}) as { city?: string; state?: string; addressCountry?: string };
      return {
        external_id: str(j.id),
        title: str(j.jobOpeningName),
        url: "",
        location: [loc.city, loc.state, loc.addressCountry].filter(Boolean).join(", "),
        posted_at: "",
        description: "",
      };
    });
  }

  // SmartRecruiters' postings list carries no description at all -- it has to be read per posting
  // from the detail endpoint, which `fetchMissingDescriptions` below does for the postings that
  // survive filtering rather than for every posting on the board.
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

/** Detail fetches are one request per posting, so this is capped per company on top of the budget. */
const MAX_DETAIL_FETCHES = 25;
const DETAIL_CONCURRENCY = 5;

/**
 * Fills in descriptions for providers whose board listing doesn't include one.
 *
 * SmartRecruiters' `/postings` list returns titles and locations but no body at all, Workday's
 * listing endpoint is the same, and BambooHR's `/careers/list` is thinner still -- no description,
 * URL, or date, only id/title/department/location. All three need one extra fetch per posting to
 * get the real text (and, for BambooHR, the posting URL too). Without this, every posting from any
 * of them reached tier-2 scoring with an empty description -- judged on its title alone, and
 * structurally unable to report a salary or years-of-experience figure no matter how clearly the
 * real posting states one.
 *
 * Deliberately called on the *filtered* set (after role and location matching), not on the whole
 * board: a detail fetch costs a request each, and there's no reason to spend one on a posting that
 * was already ruled out. Bounded twice over -- by the shared scan budget and by MAX_DETAIL_FETCHES
 * -- and every failure is swallowed, since a posting with no description is exactly the state this
 * is trying to improve on and never worse than before.
 */
export async function fetchMissingDescriptions(
  provider: AtsProvider,
  token: string,
  jobs: ScannedJob[],
  budget: { remaining: number },
): Promise<void> {
  if (provider !== "smartrecruiters" && provider !== "workday" && provider !== "bamboohr") return;
  const pending = jobs.filter((job) => !job.description && job.external_id).slice(0, MAX_DETAIL_FETCHES);

  const [tenant, pod, site] = provider === "workday" ? token.split("|") : [];
  if (provider === "workday" && (!tenant || !pod || !site)) return;
  const workdayBase = `https://${tenant}.${pod}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;

  for (let i = 0; i < pending.length; i += DETAIL_CONCURRENCY) {
    if (budget.remaining <= 5) return;
    const batch = pending.slice(i, i + DETAIL_CONCURRENCY);
    budget.remaining -= batch.length;
    await Promise.all(
      batch.map(async (job) => {
        try {
          if (provider === "workday") {
            // job.external_id is the externalPath fetchWorkdayJobs stored (e.g. "/job/.../R-12345"),
            // which is also the suffix the CXS detail endpoint expects appended to the same base
            // the listing request used.
            const res = await fetchWithTimeout(`${workdayBase}${job.external_id}`, 8000);
            if (!res || !res.ok) return;
            const detail = (await res.json().catch(() => null)) as {
              jobPostingInfo?: { jobDescription?: string };
            } | null;
            const description = detail?.jobPostingInfo?.jobDescription;
            if (description) job.description = joinSections([description]);
            return;
          }

          if (provider === "bamboohr") {
            const res = await fetchWithTimeout(`https://${token}.bamboohr.com/careers/${encodeURIComponent(job.external_id)}/detail`, 8000);
            if (!res || !res.ok) return;
            const detail = (await res.json().catch(() => null)) as {
              result?: { jobOpening?: { description?: string; jobOpeningShareUrl?: string } };
            } | null;
            const opening = detail?.result?.jobOpening;
            if (!opening) return;
            if (opening.description) job.description = joinSections([opening.description]);
            if (opening.jobOpeningShareUrl) job.url = opening.jobOpeningShareUrl;
            return;
          }

          const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings/${encodeURIComponent(job.external_id)}`;
          const res = await fetchWithTimeout(url, 8000);
          if (!res || !res.ok) return;
          const detail = (await res.json().catch(() => null)) as {
            jobAd?: { sections?: Record<string, { title?: string; text?: string } | undefined> };
          } | null;
          const sections = detail?.jobAd?.sections;
          if (!sections) return;
          // Ordered the way the posting itself reads, with additionalInformation last since that's
          // where a compensation or benefits block typically sits.
          job.description = joinSections(
            ["jobDescription", "qualifications", "additionalInformation", "companyDescription"].map((key) => {
              const section = sections[key];
              if (!section?.text) return "";
              return section.title ? `${section.title}:\n${section.text}` : section.text;
            }),
          );
        } catch {
          // Leave the description empty -- same as before this existed.
        }
      }),
    );
  }
}

/** Keeps obviously irrelevant postings out of the Jobs tab without needing a model call. */
export function filterJobsByRoles(
  jobs: ScannedJob[],
  desiredRoles: string,
  /**
   * The explicit title vocabulary from the role analysis (canonical titles, alternate titles,
   * search title terms). Strongly preferred over `desiredRoles` when present.
   *
   * Deriving match terms by scraping words out of prose is what this parameter exists to replace:
   * a role description is written for a human, so word-extraction picked up whatever incidental
   * vocabulary the sentences happened to contain and matched postings on it. Explicit terms are
   * chosen for exactly this purpose, so they both admit more real variants and reject more noise.
   */
  titleTerms: string[] = [],
): ScannedJob[] {
  const explicit = titleTerms
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));

  // A multi-word term ("developer advocate") is matched as a phrase, but its individual content
  // words are also kept as separate candidates. That is deliberate for recall: this filter runs
  // before any model sees the posting, so its job is to drop the obviously irrelevant, not to be
  // precise. "Staff Developer Advocate, Platform" must survive to reach the prescreen.
  const terms = explicit.length
    ? Array.from(
        new Set([
          ...explicit,
          ...explicit.flatMap((term) => term.split(/[^a-z0-9+#.]+/).filter((w) => w.length > 3 && !STOPWORDS.has(w))),
        ]),
      )
    : Array.from(
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

// ---------------------------------------------------------------------------
// Verification outcome
// ---------------------------------------------------------------------------
//
// There is deliberately no company-level "fit" judgment anywhere in this file. Whether a company's
// business is a good match for the candidate is a job-level question (see fit.ts's
// assessJobFitBatch, which judges a specific posting) -- a company is worth monitoring purely on
// operational grounds: does a real, readable job board exist for it. A non-tech company that
// occasionally hires an AI engineer is exactly as "verified" as a company whose whole business is
// AI, once both have a confirmed website and a board this app can read.

export type VerifyReason = "" | "no_website" | "no_job_board" | "unsupported_ats" | "board_unreachable" | "ambiguous";

export type VerifyOutcome = { status: "verified" | "unverified"; verify_reason: VerifyReason };

/**
 * Turns a board-resolution attempt into the status/reason pair companies.status/verify_reason
 * store, matching the exact reason taxonomy the Unverified tab filters on. Pure and synchronous so
 * it's fully unit-testable independent of any actual network call -- the caller (index.ts) is
 * responsible for the fetches themselves and passes in only what was learned.
 *
 * `hadPriorSuccess` covers one deliberate asymmetry: a company that has already been read
 * successfully at least once (a real, working board is known) is never demoted back to unverified
 * by a later transient read failure -- that would flip a perfectly good company in and out of
 * Verified on nothing but network flakiness. A read failure only counts as a verification outcome
 * (board_unreachable) the first time a company's board is ever attempted.
 */
export function classifyVerification(
  hasWebsite: boolean,
  resolution: BoardResolution,
  readFailed: boolean,
  hadPriorSuccess: boolean,
): VerifyOutcome {
  if (!hasWebsite) return { status: "unverified", verify_reason: "no_website" };
  if (!resolution) return { status: "unverified", verify_reason: "no_job_board" };
  if (!isReadableAtsProvider(resolution.provider)) return { status: "unverified", verify_reason: "unsupported_ats" };
  if (readFailed && !hadPriorSuccess) return { status: "unverified", verify_reason: "board_unreachable" };
  return { status: "verified", verify_reason: "" };
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "are", "was", "were", "you",
  "your", "their", "they", "would", "could", "should", "like", "want", "looking", "role", "roles",
  "job", "jobs", "work", "working", "company", "companies", "team", "teams", "years", "year",
  "experience", "candidate", "position", "positions", "opportunity", "opportunities", "where",
  "which", "into", "about", "more", "most", "also", "such", "than", "then", "some", "any", "can",
]);

// ---------------------------------------------------------------------------
// Company search terms -- shaping only. index.ts owns the actual persisted list (reads/writes
// preferences_json) and the role-analysis extraction (readRoleAnalysis/roleTitleTerms); the two
// pure transformations below live here instead so they're unit-testable the same way every other
// deterministic rule in this file is, without pulling index.ts's DB/route plumbing into a test.
// ---------------------------------------------------------------------------

export type CompanySearchTerm = { term: string; source: "generated" | "manual" };

const MAX_GENERATED_SEARCH_TERMS = 15;

export function titleCaseTerm(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Shapes raw extracted title strings (from index.ts's roleTitleTerms) into the generated half of
 *  the editable Search Terms list: capped, title-cased, tagged source:'generated'. */
export function companySearchTermsFromTitles(titles: string[]): CompanySearchTerm[] {
  return titles.slice(0, MAX_GENERATED_SEARCH_TERMS).map((t) => ({ term: titleCaseTerm(t), source: "generated" as const }));
}

/** "Reset to suggested": the candidate's own manual terms are always kept, with freshly generated
 *  suggestions filling in after, deduped case-insensitively against the manual ones so a suggestion
 *  matching something the candidate already typed doesn't show up twice. */
export function mergeCompanySearchTerms(manual: CompanySearchTerm[], generated: CompanySearchTerm[]): CompanySearchTerm[] {
  return [...manual, ...generated.filter((g) => !manual.some((m) => m.term.toLowerCase() === g.term.toLowerCase()))];
}
