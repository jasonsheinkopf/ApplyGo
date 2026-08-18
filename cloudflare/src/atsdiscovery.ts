// Direct company -> ATS discovery: "does this employer have a board on Greenhouse? Lever? Ashby?
// SmartRecruiters? ..." asked systematically, bounded, and budget-aware -- independent of whether
// the company's own corporate website has been found.
//
// This is the architectural change the ATS-discovery product brief calls for: previously, finding a
// company's job board was gated entirely behind first finding its website (see scanOneCompany in
// index.ts, which used to return "unresolved" the moment company.website was empty, before ever
// attempting an ATS lookup). A company's actual job source is the target; the corporate website is
// useful corroborating evidence, not a prerequisite. This module lets a caller ask "can we read this
// employer's jobs" directly, and only falls back to the website/careers-page route (companies.ts's
// resolveBoard) when this sweep comes up empty.
//
// Same "propose, then verify" discipline as everywhere else in this pipeline: a slug guessed from
// the company's name is NEVER accepted just because a board happens to exist at that slug -- lots of
// wrong-but-plausible collisions exist (two companies both plausibly slugging to "acme"). Every
// candidate that has real listings is additionally checked against the board's own public page for
// evidence it actually names this employer, reusing resolver.ts's scoreSiteMatch -- the exact same
// title/og:site_name/schema.org check already used to confirm a guessed company *website*, applied
// here to a guessed company *board* instead.

import {
  type AtsProvider,
  ATS_SWEEP_PROVIDER_ORDER,
  type FailureReason,
  boardApiUrl,
  boardHasListings,
  boardUrlFor,
  classifyFetchFailure,
  fetchWithDiagnostics,
  slugsFromName,
} from "./companies.ts";
import { cleanCompanyName, domainCandidates } from "./identity.ts";
import { scoreSiteMatch } from "./resolver.ts";

/** Everything the sweep can use to build candidate slugs and disambiguate a hit. Deliberately the
 *  same shape as resolver.ts's DiscoveryEvidence, so a caller building one already has the other. */
export type AtsSweepEvidence = {
  name: string;
  /** URLs discovery already has for this employer (an Adzuna posting redirect, a stored careers
   *  URL) -- tried directly for an ATS pattern before any slug is ever guessed, since they're free
   *  and often already point straight at the board. */
  urls?: string[];
};

export type AtsSweepOutcome =
  | {
      status: "found";
      provider: AtsProvider;
      token: string;
      boardUrl: string;
      confidence: number;
      evidence: string;
      /** How many real requests this sweep spent, for the caller's own diagnostics/logging. */
      requestsUsed: number;
    }
  | {
      status: "not_found";
      requestsUsed: number;
      /** The strongest failure reason observed across every candidate tried, for the UI's
       *  "why did this fail" view -- e.g. every candidate 429'd vs. every candidate cleanly 404'd
       *  are very different situations to be looking at. */
      reason: FailureReason;
      /** Present only when a board's *listings* were found but its page evidence didn't confirm the
       *  employer -- the "wrong company, similar slug" case the brief specifically calls out as
       *  something that must never be silently accepted. */
      rejectedCandidate?: { provider: AtsProvider; token: string; boardUrl: string; bestScore: number };
    };

/** Below this, a board's page evidence is not enough to accept the guessed slug as this employer.
 *  Deliberately lower than resolver.ts's CONFIDENCE_FLOOR (60): an ATS-hosted board page is often
 *  thinner than a full corporate site (no schema.org block, a shorter title), but it is combined
 *  here with the much stronger prior of "a real, currently-open board exists at a slug derived from
 *  this exact company name" -- something resolver.ts's website guess has no equivalent of. */
export const ATS_IDENTITY_FLOOR = 35;

/** Hard ceiling on real requests this sweep will ever spend on one company, independent of however
 *  much of the shared scan budget remains -- "one pathological company must never consume the whole
 *  batch" from the product brief. Candidate slugs x providers is bounded far below this already
 *  (see candidateSlugs/ATS_SWEEP_PROVIDER_ORDER), but the cap is kept explicit rather than implied. */
const MAX_SWEEP_REQUESTS = 12;

/** At most this many slug candidates are tried per provider -- the single best domain-style guess
 *  and the single best name-style guess, deduplicated. Matches probePlan's (resolver.ts) reasoning:
 *  the first guess is right often enough that trying a third and fourth mostly just burns budget on
 *  the companies where none of them were ever going to be right. */
function candidateSlugs(name: string): string[] {
  const cleaned = cleanCompanyName(name);
  if (!cleaned) return [];
  const fromDomain = domainCandidates(cleaned).slice(0, 1);
  const fromName = slugsFromName(cleaned).slice(0, 2);
  return Array.from(new Set([...fromDomain, ...fromName])).filter(Boolean);
}

/**
 * Verifies a candidate board actually belongs to `name` by fetching the board's own public page and
 * scoring it the same way resolver.ts scores a candidate website -- title, og:site_name, schema.org
 * Organization name, and full-name mentions in the body. A board that exists but fails this check is
 * reported, never silently trusted: see AtsSweepOutcome's `rejectedCandidate`.
 */
async function verifyBoardIdentity(
  name: string,
  provider: AtsProvider,
  token: string,
  budget: { remaining: number },
): Promise<{ score: number; evidence: string } | null> {
  const pageUrl = boardUrlFor(provider, token);
  if (!pageUrl || budget.remaining <= 0) return null;
  budget.remaining -= 1;
  const { res } = await fetchWithDiagnostics(pageUrl, 8000, { redirect: "follow" });
  if (!res || !res.ok) return null;
  const html = await res.text().catch(() => "");
  if (!html) return null;
  return scoreSiteMatch(name, html);
}

/**
 * Tries every readable ATS provider (companies.ts's ATS_SWEEP_PROVIDER_ORDER) against a bounded set
 * of plausible board slugs, stopping at the first candidate whose board both has real listings AND
 * verifies as this employer. Every real fetch -- the API existence check and the identity-page
 * check alike -- is metered against `budget`, the same shared cap resolveBoard/resolveWebsiteDeterministic
 * already decrement, so this sweep can never blow past a batch's total request ceiling on its own.
 */
export async function sweepAtsProviders(
  evidence: AtsSweepEvidence,
  budget: { remaining: number },
): Promise<AtsSweepOutcome> {
  const name = cleanCompanyName(evidence.name);
  let requestsUsed = 0;

  let worstReason: FailureReason = "";
  let rejected: { provider: AtsProvider; token: string; boardUrl: string; bestScore: number } | undefined;

  // --- Free-ish first: any evidence URL discovery already handed us may itself name an ATS. -------
  for (const raw of evidence.urls ?? []) {
    for (const provider of ATS_SWEEP_PROVIDER_ORDER) {
      const match = raw.match(providerHostPattern(provider));
      if (!match?.[1]) continue;
      const token = match[1];
      if (budget.remaining <= 0 || requestsUsed >= MAX_SWEEP_REQUESTS) break;
      budget.remaining -= 1;
      requestsUsed += 1;
      const apiRes = await fetchWithDiagnostics(boardApiUrl(provider, token), 8000);
      if (!apiRes.res || !apiRes.res.ok) {
        worstReason = strongerReason(worstReason, classifyFetchFailure(apiRes.res, "", apiRes.timedOut));
        continue;
      }
      const body = await apiRes.res.text().catch(() => "");
      if (!body || !boardHasListings(provider, body)) continue;
      const verified = await verifyBoardIdentity(name, provider, token, budget);
      requestsUsed += 1;
      if (verified && verified.score >= ATS_IDENTITY_FLOOR) {
        return {
          status: "found", provider, token, boardUrl: boardUrlFor(provider, token),
          confidence: verified.score, evidence: `from discovery evidence url: ${verified.evidence}`, requestsUsed,
        };
      }
      if (verified && (!rejected || verified.score > rejected.bestScore)) {
        rejected = { provider, token, boardUrl: boardUrlFor(provider, token), bestScore: verified.score };
      }
    }
  }

  // --- Bounded guess: candidate slugs x readable providers, most-likely-first. ----------------------
  const slugs = candidateSlugs(name);
  outer: for (const slug of slugs) {
    for (const provider of ATS_SWEEP_PROVIDER_ORDER) {
      if (budget.remaining <= 0 || requestsUsed >= MAX_SWEEP_REQUESTS) break outer;

      budget.remaining -= 1;
      requestsUsed += 1;
      const { res, timedOut } = await fetchWithDiagnostics(boardApiUrl(provider, slug), 8000);
      if (!res || !res.ok) {
        worstReason = strongerReason(worstReason, classifyFetchFailure(res, "", timedOut));
        continue;
      }
      const body = await res.text().catch(() => "");
      if (!body || !boardHasListings(provider, body)) continue;

      // A board with real listings exists at this slug. A guessed slug must never count as a match
      // by itself -- confirm it against the board's own public page before trusting it.
      if (budget.remaining <= 0 || requestsUsed >= MAX_SWEEP_REQUESTS) {
        worstReason = strongerReason(worstReason, "budget_exhausted");
        break outer;
      }
      const verified = await verifyBoardIdentity(name, provider, slug, budget);
      requestsUsed += 1;
      if (verified && verified.score >= ATS_IDENTITY_FLOOR) {
        return {
          status: "found", provider, token: slug, boardUrl: boardUrlFor(provider, slug),
          confidence: verified.score, evidence: verified.evidence, requestsUsed,
        };
      }
      if (verified) {
        worstReason = strongerReason(worstReason, "identity_unverified_on_board");
        if (!rejected || verified.score > rejected.bestScore) {
          rejected = { provider, token: slug, boardUrl: boardUrlFor(provider, slug), bestScore: verified.score };
        }
      }
    }
  }

  return { status: "not_found", requestsUsed, reason: worstReason, rejectedCandidate: rejected };
}

/** Rough severity ordering so the "worst" (most informative) failure reason survives across many
 *  candidates -- a single 429 among nine clean 404s is far more useful to surface than the 404s. */
const REASON_SEVERITY: FailureReason[] = [
  "", "http_404", "dns_or_network", "timeout", "access_restricted", "http_403",
  "identity_unverified_on_board", "login_required", "http_429", "probable_captcha",
  "cloudflare_challenge", "js_challenge_page", "malformed_response", "budget_exhausted",
];
function strongerReason(a: FailureReason, b: FailureReason): FailureReason {
  return REASON_SEVERITY.indexOf(b) > REASON_SEVERITY.indexOf(a) ? b : a;
}

/** The same per-provider hostname pattern companies.ts's ATS_PATTERNS uses to recognize a provider
 *  from a URL, narrowed to the seven this sweep can guess candidates for. Kept local rather than
 *  imported: companies.ts's ATS_PATTERNS array is not exported (it also carries the ten detect-only
 *  providers this module never guesses at), and duplicating just the capture shape for the seven
 *  readable ones this file cares about is simpler than reshaping that export boundary for one use. */
function providerHostPattern(provider: AtsProvider): RegExp {
  switch (provider) {
    case "greenhouse": return /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i;
    case "lever": return /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i;
    case "ashby": return /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i;
    case "smartrecruiters": return /careers\.smartrecruiters\.com\/([a-z0-9_-]+)/i;
    case "workable": return /apply\.workable\.com\/([a-z0-9_-]+)/i;
    case "recruitee": return /([a-z0-9-]+)\.recruitee\.com/i;
    case "bamboohr": return /([a-z0-9-]+)\.bamboohr\.com\/(?:jobs|careers)/i;
    default: return /$^/;
  }
}
