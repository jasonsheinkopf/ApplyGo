// Search-grounded website resolution -- the fallback for a company the deterministic slug-guess in
// companies.ts's resolveCompanyDomain() couldn't place. That guess is the default path and stays
// free and instant; this only ever runs after it has already failed.
//
// The one rule this file exists to enforce: a company name alone is not enough to answer "what is
// this company's website" from a model's memory, because names collide -- asking a plain LLM with no
// search access just turns its memory into another source of hallucination. Every call here goes
// through callWithWebSearch (src/llm.ts), which gives the model Claude's own real, current web
// search rather than trusting recall. The result is still never accepted as-is: index.ts is
// responsible for deterministically re-verifying the returned URL (the same verifyWebsite() check
// every other website in this app goes through) before any company is marked Verified from it.

import { type LlmEnv, callWithWebSearch } from "./llm.ts";
import { getManagedPrompt } from "./langfuse.ts";
import { atsDisplayName, ATS_SWEEP_PROVIDER_ORDER } from "./companies.ts";
import { COMPANIES_RESOLVE_WEBSITE_PROMPT } from "./prompts.ts";

export type WebsiteResolution = {
  official_website: string;
  careers_url: string;
  /**
   * A specific ATS/job-board URL the search turned up (e.g. a Greenhouse or Lever board page),
   * proposed independent of whether official_website was found. This is the "propose" half of
   * "model proposes, deterministic code verifies": index.ts's scanOneCompany never trusts this
   * directly, and only accepts it once detectAtsFromUrl recognizes a supported provider AND the
   * board's own public page confirms this employer's name via resolver.ts's scoreSiteMatch -- the
   * exact discipline every other guessed candidate in this app already goes through. Empty string
   * when search found no plausible board.
   */
  ats_board_url: string;
  confidence: number;
  reason: string;
};

export const WEBSITE_RESOLUTION_SCHEMA = {
  type: "object",
  properties: {
    official_website: {
      type: "string",
      description: "The company's real, official homepage URL, e.g. https://example.com. Empty string if you cannot confirm one.",
    },
    careers_url: {
      type: "string",
      description: "Their careers/jobs page URL if you found one during search, else empty string.",
    },
    ats_board_url: {
      type: "string",
      description:
        "A specific job-board/ATS URL for this exact employer if search found one (e.g. https://job-boards.greenhouse.io/acme, " +
        "https://jobs.lever.co/acme) -- even if you could not confirm their official homepage. Empty string if none found.",
    },
    confidence: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "0-100: how sure you are this is the right company, not merely a plausible one with a similar name.",
    },
    reason: {
      type: "string",
      description: "One sentence citing what specifically confirmed the match, or explaining why you're unsure.",
    },
  },
  required: ["official_website", "careers_url", "ats_board_url", "confidence", "reason"],
} as const;

export type CompanyEvidence = { name: string; location: string; signal: string };

/**
 * Returns null (never throws) when the search fallback simply isn't available or didn't produce a
 * usable answer -- callers treat that identically to "still unresolved", the same outcome as if
 * this were never attempted. `evidence` is everything discovery already knows about the company
 * (its hiring signal, location) so the model has something to disambiguate a common name against,
 * per the same reasoning fitPrompt already applies: real context beats a bare name.
 */
export async function resolveWebsiteViaSearch(env: LlmEnv, evidence: CompanyEvidence): Promise<WebsiteResolution | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const atsProviders = ATS_SWEEP_PROVIDER_ORDER.map((p) => atsDisplayName(p)).join(", ");
    const prompt = await getManagedPrompt(
      env,
      "companies/resolve_website",
      {
        company_name: evidence.name,
        location: evidence.location || "not specified",
        signal: evidence.signal || "not specified",
        ats_providers: atsProviders,
      },
      COMPANIES_RESOLVE_WEBSITE_PROMPT,
    );
    const result = await callWithWebSearch<WebsiteResolution>(
      env,
      "companies.resolve_website",
      prompt,
      WEBSITE_RESOLUTION_SCHEMA,
      "submit_website_resolution",
      1500,
      3,
    );
    return {
      official_website: String(result.official_website ?? "").trim(),
      careers_url: String(result.careers_url ?? "").trim(),
      ats_board_url: String(result.ats_board_url ?? "").trim(),
      confidence: Number.isFinite(result.confidence) ? Math.max(0, Math.min(100, Math.round(result.confidence))) : 0,
      reason: String(result.reason ?? "").trim(),
    };
  } catch {
    return null;
  }
}
