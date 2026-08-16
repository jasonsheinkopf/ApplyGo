// Company discovery grounded in real, current hiring activity, via the Adzuna Job Search API
// (https://developer.adzuna.com/) -- a free-tier third-party job aggregator, used here strictly to
// find which companies are worth investigating further. This does not weaken the "no aggregators"
// principle in companies.ts's own header comment: no job listing shown to the candidate ever comes
// from Adzuna. Once a company is discovered here, every posting they see still comes only from that
// company's own ATS board, read the same way it always has been.
//
// Deliberately no LLM anywhere in this file. Adzuna's response already has a structured `company`
// field per posting -- reading it is a JSON property access, not something that benefits from (or
// needs to risk) a model's involvement.

import { companyNameKey, fetchWithTimeout } from "./companies.ts";

export interface AdzunaEnv {
  ADZUNA_APP_ID?: string;
  ADZUNA_APP_KEY?: string;
  /** ISO country code Adzuna's per-country endpoint expects, e.g. "us", "gb", "de". */
  ADZUNA_COUNTRY?: string;
}

export function adzunaConfigured(env: AdzunaEnv): boolean {
  return Boolean(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY);
}

export function adzunaCountry(env: AdzunaEnv): string {
  return (env.ADZUNA_COUNTRY || "us").trim().toLowerCase();
}

export type AdzunaPosting = {
  /** Adzuna's own posting id -- the stable identity used to dedupe postings across overlapping
   *  pages, distinct from companyNameKey's company-level dedup. */
  id: string;
  title: string;
  company: string;
  location: string;
  category: string;
  created: string;
  url: string;
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * One page of Adzuna's search endpoint. Throws a distinguishable error on a real HTTP or parse
 * failure -- same principle as fetchBoardJobs's board_http_/board_bad_json throws in companies.ts --
 * so a caller running many of these in a pool can isolate one bad query rather than losing an entire
 * discovery run to it. A 429 gets its own distinct error (adzuna_rate_limited) so a caller can tell
 * "the free tier's rate limit was hit, pause and try again later" apart from a genuine failure --
 * conflating the two would either mark a perfectly good query exhausted (it isn't; there's more to
 * find) or keep retrying it uselessly in the same run (it won't succeed until the limit resets).
 */
export async function searchAdzunaPage(
  env: AdzunaEnv,
  what: string,
  where: string,
  page: number,
  resultsPerPage: number,
): Promise<{ postings: AdzunaPosting[]; count: number }> {
  if (!adzunaConfigured(env)) throw new Error("adzuna_not_configured");
  const country = adzunaCountry(env);
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/${Math.max(1, page)}`);
  url.searchParams.set("app_id", env.ADZUNA_APP_ID!);
  url.searchParams.set("app_key", env.ADZUNA_APP_KEY!);
  url.searchParams.set("what", what);
  if (where) url.searchParams.set("where", where);
  url.searchParams.set("results_per_page", String(Math.max(1, Math.min(50, resultsPerPage))));
  url.searchParams.set("content-type", "application/json");

  const res = await fetchWithTimeout(url.toString(), 10000);
  if (!res) throw new Error("adzuna_unreachable");
  if (res.status === 429) throw new Error("adzuna_rate_limited");
  if (!res.ok) throw new Error(`adzuna_http_${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("adzuna_bad_json");
  }
  const record = body as Record<string, unknown>;
  const results = Array.isArray(record.results) ? record.results : [];
  const postings: AdzunaPosting[] = results.map((raw) => {
    const r = raw as Record<string, unknown>;
    const company = r.company as Record<string, unknown> | undefined;
    const location = r.location as Record<string, unknown> | undefined;
    return {
      id: str(r.id),
      title: str(r.title),
      company: str(company?.display_name),
      location: str(location?.display_name),
      category: str((r.category as Record<string, unknown> | undefined)?.label),
      created: str(r.created),
      url: str(r.redirect_url),
    };
  });
  return { postings, count: typeof record.count === "number" ? record.count : postings.length };
}

export type DiscoveredCompany = {
  name: string;
  location: string;
  signal: string;
  postings_seen: number;
  /**
   * Posting URLs seen for this employer. These are the highest-value input the website resolver
   * gets -- a URL the aggregator itself published for this company outranks any hostname guess --
   * and they used to be discarded the moment the company name was extracted. Capped, since only a
   * couple are ever needed to disambiguate.
   */
  urls: string[];
};

const MAX_SIGNAL_TITLES = 3;
const MAX_EVIDENCE_URLS = 3;

/**
 * Groups raw postings by companyNameKey(posting.company) -- the same normalization every other
 * dedup in this app uses -- and reduces each group to a compact, deterministic `signal` string the
 * fit-screening prompt reads in place of an LLM-authored bio: a handful of sampled real titles plus
 * how many postings were seen, not a summary a model wrote.
 *
 * Deduplicates by posting id first (falling back to keeping a posting with no id, rather than
 * dropping it, since an id-less posting can't collide with anything by definition): a resumable
 * multi-stream discovery run can genuinely see the same real posting twice, e.g. two different
 * search terms both matching one listing, or Adzuna's own ranking shifting a posting across a page
 * boundary between calls. Without this, the same real opening would inflate a company's
 * postings_seen count and pad its signal with a repeated title.
 */
export function aggregateCompanies(postings: AdzunaPosting[]): DiscoveredCompany[] {
  const seenIds = new Set<string>();
  const groups = new Map<string, { name: string; location: string; titles: string[]; count: number; urls: string[] }>();
  for (const posting of postings) {
    if (posting.id) {
      if (seenIds.has(posting.id)) continue;
      seenIds.add(posting.id);
    }
    const name = posting.company.trim();
    if (!name) continue;
    const key = companyNameKey(name);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = { name, location: posting.location.trim(), titles: [], count: 0, urls: [] };
      groups.set(key, group);
    }
    group.count += 1;
    const url = posting.url?.trim();
    if (url && !group.urls.includes(url) && group.urls.length < MAX_EVIDENCE_URLS) group.urls.push(url);
    const title = posting.title.trim();
    if (title && !group.titles.includes(title) && group.titles.length < MAX_SIGNAL_TITLES) {
      group.titles.push(title);
    }
  }
  return Array.from(groups.values()).map((group) => ({
    name: group.name,
    location: group.location,
    signal: `Hiring for: ${group.titles.join(", ")}${group.count > group.titles.length ? ` (${group.count} postings seen)` : ""}`,
    postings_seen: group.count,
    urls: group.urls,
  }));
}
