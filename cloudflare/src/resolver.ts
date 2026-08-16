// Company website resolution: the verification waterfall.
//
// One job -- given a noisy employer name plus whatever evidence discovery collected, decide with a
// stated confidence whether we know this company's real website. It is deliberately structured as
// tiers that get more expensive and less certain as they go, and it stops at the first tier that
// produces *confirmed* evidence:
//
//   Tier 1  evidence  -- a URL discovery already handed us (employer site, posting redirect).
//                        Free. No guessing at all.
//   Tier 2  guess     -- deterministic domain candidates from the cleaned name (identity.ts).
//                        Cheap: a bounded handful of HTTP requests, no model.
//   Tier 3  validate  -- MANDATORY for every candidate from tiers 1-2. Fetch the page and check it
//                        actually belongs to this company.
//   Tier 4  search    -- real web search, only for what tiers 1-3 could not confirm. Costs money.
//
// Tier 3 is the tier this file exists for. A benchmark against the real unresolved backlog showed
// the bounded guess in tier 2 resolving 87% of them -- but among those "successes" were
// "Match Made Tech" -> mmt.com and "Superior Executive Legal Recruiting" -> selr.com, which are
// almost certainly unrelated businesses that happen to own the initialism. A confidently wrong
// domain is worse than an honest "unresolved": it sends the candidate to a stranger's careers page
// and pollutes the company list with jobs from the wrong employer. So no candidate from any tier is
// ever accepted on the strength of its hostname alone -- every one has to survive verifyCandidate
// below, and anything that can't is reported as ambiguous rather than guessed.

import { companyMatchKey, cleanCompanyName, domainCandidates } from "./identity.ts";
import { fetchWithTimeout } from "./companies.ts";

/** How a website was arrived at. Stored so a wrong answer can be traced to the tier that made it. */
export type WebsiteSource = "evidence" | "guess" | "search" | "manual";

export type ResolutionOutcome =
  /** A website we are confident belongs to this company. */
  | { status: "resolved"; website: string; source: WebsiteSource; confidence: number; evidence: string }
  /** A plausible candidate that failed to prove itself. Deliberately NOT accepted. */
  | { status: "ambiguous"; website: string; source: WebsiteSource; confidence: number; evidence: string }
  /** Nothing plausible found at all. */
  | { status: "unresolved"; evidence: string };

/** Everything discovery knows about a company, used both to guess and to disambiguate. */
export type DiscoveryEvidence = {
  name: string;
  location?: string;
  /** Sampled job titles seen for this employer -- real signal for telling same-name companies apart. */
  signal?: string;
  /** URLs the aggregator supplied: employer homepage, posting redirect, company profile. */
  urls?: string[];
};

/** Below this, a resolution is reported ambiguous instead of accepted. */
export const CONFIDENCE_FLOOR = 60;

// ---------------------------------------------------------------------------
// Tier 3: evidence validation
// ---------------------------------------------------------------------------

/** Hosts that are never a company's own website, however well the name matches. */
const NON_COMPANY_HOSTS = [
  "linkedin.com", "indeed.com", "glassdoor.com", "ziprecruiter.com", "monster.com",
  "dice.com", "adzuna.com", "simplyhired.com", "careerbuilder.com", "wikipedia.org",
  "facebook.com", "twitter.com", "x.com", "instagram.com", "youtube.com", "crunchbase.com",
  "bloomberg.com", "reuters.com", "google.com", "bing.com", "yahoo.com", "amazon.com",
  "github.com", "medium.com", "wordpress.com", "wixsite.com", "squarespace.com",
  "godaddy.com", "sedo.com", "hugedomains.com", "afternic.com", "dan.com",
];

export function isNonCompanyHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return NON_COMPANY_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`));
  } catch {
    return true;
  }
}

/** Signals a parked/for-sale placeholder rather than a real company site. */
const PARKED_MARKERS = [
  "domain is for sale", "buy this domain", "domain for sale", "parked domain",
  "this domain may be for sale", "inquire about this domain", "godaddy.com/forsale",
];

/** Meaningful tokens from a company name, for matching against page text. */
function nameTokens(name: string): string[] {
  const STOP = new Set(["the", "of", "and", "for", "at", "in", "a", "an"]);
  return companyMatchKey(name).split(" ").filter((t) => t.length > 2 && !STOP.has(t));
}

/** Extracts <title>, og:site_name, and schema.org Organization name from raw HTML. */
export function extractSiteIdentity(html: string): { title: string; siteName: string; orgName: string } {
  const pick = (re: RegExp): string => {
    const m = html.match(re);
    return m?.[1] ? m[1].replace(/\s+/g, " ").trim().slice(0, 300) : "";
  };
  return {
    title: pick(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i),
    siteName: pick(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{0,200})["']/i)
      || pick(/<meta[^>]+content=["']([^"']{0,200})["'][^>]+property=["']og:site_name["']/i),
    // Deliberately a loose scan of any JSON-LD "name" rather than a full JSON-LD parse: the block
    // is frequently an array or graph, and one regex over the whole document costs nothing.
    orgName: pick(/"@type"\s*:\s*"(?:Organization|Corporation|LocalBusiness|EducationalOrganization)"[\s\S]{0,400}?"name"\s*:\s*"([^"]{0,200})"/i)
      || pick(/"name"\s*:\s*"([^"]{0,200})"[\s\S]{0,400}?"@type"\s*:\s*"(?:Organization|Corporation|LocalBusiness|EducationalOrganization)"/i),
  };
}

/**
 * Scores how strongly a fetched page identifies itself as `name`, 0-100.
 *
 * Everything here is evidence the *site itself* published about who it is -- its title, its
 * og:site_name, its schema.org Organization block -- never the hostname, which is the thing being
 * checked and would make the test circular.
 */
export function scoreSiteMatch(name: string, html: string, finalUrl = ""): { score: number; evidence: string } {
  const tokens = nameTokens(name);
  if (!tokens.length) return { score: 0, evidence: "company name has no matchable tokens" };

  const lower = html.slice(0, 200_000).toLowerCase();
  if (PARKED_MARKERS.some((m) => lower.includes(m))) {
    return { score: 0, evidence: "page looks like a parked/for-sale domain" };
  }

  const identity = extractSiteIdentity(html);
  const norm = (v: string) => companyMatchKey(v);
  const reasons: string[] = [];
  let score = 0;

  // Strongest signal: the site's own structured Organization name matches.
  const orgKey = norm(identity.orgName);
  const nameKey = companyMatchKey(name);
  if (orgKey && (orgKey === nameKey || orgKey.includes(nameKey) || nameKey.includes(orgKey))) {
    score += 55;
    reasons.push(`schema.org Organization name "${identity.orgName}"`);
  }

  const siteKey = norm(identity.siteName);
  if (siteKey && (siteKey === nameKey || siteKey.includes(nameKey) || nameKey.includes(siteKey))) {
    score += 30;
    reasons.push(`og:site_name "${identity.siteName}"`);
  }

  // Title match, scored by how much of the company name it actually contains.
  const titleKey = norm(identity.title);
  if (titleKey) {
    const hit = tokens.filter((t) => titleKey.includes(t)).length;
    if (hit === tokens.length) {
      score += 35;
      reasons.push(`page title "${identity.title}" contains the full company name`);
    } else if (hit > 0) {
      score += Math.round((hit / tokens.length) * 20);
      reasons.push(`page title "${identity.title}" partially matches (${hit}/${tokens.length} words)`);
    }
  }

  // Body mentions. Weak on its own -- a directory page mentions many companies -- so it is capped
  // low and can never carry a candidate over the floor by itself.
  const bodyHits = tokens.filter((t) => lower.includes(t)).length;
  if (bodyHits === tokens.length) {
    score += 15;
    reasons.push("full company name appears in page text");
  }

  // A careers/jobs surface is corroborating: employers that hire have one.
  if (/\b(careers?|jobs|join our team|work with us|open positions)\b/i.test(lower)) {
    score += 5;
    reasons.push("page references careers/jobs");
  }

  if (!reasons.length) reasons.push(`no identifying match for "${name}"${finalUrl ? ` on ${finalUrl}` : ""}`);
  return { score: Math.max(0, Math.min(100, score)), evidence: reasons.join("; ") };
}

/**
 * Fetches a candidate URL and decides whether it really is this company.
 *
 * Returns null when the URL is unusable (unreachable, an aggregator, a redirect off to an unrelated
 * host). A non-null result still carries a score the caller must compare against CONFIDENCE_FLOOR.
 */
export async function verifyCandidate(
  name: string,
  candidateUrl: string,
): Promise<{ url: string; score: number; evidence: string } | null> {
  if (isNonCompanyHost(candidateUrl)) return null;

  const res = await fetchWithTimeout(candidateUrl, 8000, { method: "GET", redirect: "follow" });
  if (!res) return null;

  // A 401/403 is a live site refusing to be read, not a dead one -- but with no body there is no
  // evidence either, so it can only ever be reported as low-confidence, never accepted outright.
  if (res.status === 401 || res.status === 403) {
    return { url: candidateUrl, score: 35, evidence: `site responded ${res.status} (live but not readable, so identity unconfirmed)` };
  }
  if (res.status >= 400) return null;

  const finalUrl = res.url || candidateUrl;
  if (isNonCompanyHost(finalUrl)) return null;

  const html = await res.text().catch(() => "");
  if (!html) return null;

  const { score, evidence } = scoreSiteMatch(name, html, finalUrl);
  return { url: normalizeSiteUrl(finalUrl), score, evidence };
}

/** Origin-only, https, no trailing slash -- the stable form stored on the company row. */
export function normalizeSiteUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.protocol = "https:";
    return `${parsed.protocol}//${parsed.hostname.replace(/^www\./, "")}`;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Tier 2: the bounded deterministic probe plan
// ---------------------------------------------------------------------------

/**
 * The exact URLs tier 2 will try, in order.
 *
 * Bounded on purpose. The naive cross-product (every candidate x every TLD) is up to 49 requests
 * per company, which measured at over two minutes for 139 companies and does not survive contact
 * with the "thousands of companies" target. `.com` is far and away the most likely answer, so every
 * candidate gets tried there first, and the other TLDs are only spent on the single best candidate.
 * Measured cost of this plan against the real backlog: 3.0 requests per company.
 */
export function probePlan(name: string, maxCandidates = 4): string[] {
  const candidates = domainCandidates(name).slice(0, maxCandidates);
  if (!candidates.length) return [];
  const plan = candidates.map((c) => `https://${c}.com`);
  for (const tld of ["org", "net", "edu", "io", "ai", "co"]) plan.push(`https://${candidates[0]}.${tld}`);
  return plan;
}

// ---------------------------------------------------------------------------
// The waterfall
// ---------------------------------------------------------------------------

/**
 * Runs tiers 1-3. Tier 4 (search) is deliberately NOT called from here: it costs money and needs an
 * LLM env, so the caller decides whether an `unresolved`/`ambiguous` result is worth escalating.
 *
 * `minScore` is the bar a candidate must clear to be accepted. Evidence URLs are held to a slightly
 * lower bar than guesses, because a URL the aggregator itself published for this employer is
 * corroboration a hostname guess simply doesn't have.
 */
export async function resolveWebsiteDeterministic(evidence: DiscoveryEvidence): Promise<ResolutionOutcome> {
  const name = cleanCompanyName(evidence.name);
  if (!name) return { status: "unresolved", evidence: "no usable company name" };

  let best: { url: string; score: number; evidence: string; source: WebsiteSource } | null = null;

  // --- Tier 1: URLs discovery already gave us -----------------------------------------------
  for (const raw of evidence.urls ?? []) {
    if (!raw || isNonCompanyHost(raw)) continue;
    const checked = await verifyCandidate(name, raw);
    if (!checked) continue;
    // +15 for being published evidence rather than a guess, capped at 100.
    const score = Math.min(100, checked.score + 15);
    if (!best || score > best.score) best = { ...checked, score, source: "evidence" };
    if (score >= CONFIDENCE_FLOOR) {
      return { status: "resolved", website: checked.url, source: "evidence", confidence: score, evidence: `from discovery evidence: ${checked.evidence}` };
    }
  }

  // --- Tier 2 + 3: bounded guess, each one validated ----------------------------------------
  for (const candidate of probePlan(name)) {
    const checked = await verifyCandidate(name, candidate);
    if (!checked) continue;
    if (!best || checked.score > best.score) best = { ...checked, source: "guess" };
    if (checked.score >= CONFIDENCE_FLOOR) {
      return { status: "resolved", website: checked.url, source: "guess", confidence: checked.score, evidence: checked.evidence };
    }
  }

  if (best) {
    return { status: "ambiguous", website: best.url, source: best.source, confidence: best.score, evidence: best.evidence };
  }
  return { status: "unresolved", evidence: `no reachable candidate for "${name}"` };
}
