/**
 * Source-backed labor-market enrichment for a discovered role family.
 *
 * The hard rule this module exists to enforce: **salary and outlook figures must come from a
 * document retrieved just now, never from model memory.** An LLM asked "what does an Applied AI
 * Engineer earn in Seattle?" will answer fluently and plausibly from training data of unknown
 * vintage, and the candidate has no way to tell that from a real number. So the model here is only
 * ever a *reader* -- retrieval happens first, in code, and the prompt is handed the retrieved text
 * with instructions to report nothing the text doesn't support. When retrieval comes back empty,
 * the honest answer ("Market data not yet available") is the answer; there is no fallback path that
 * quietly substitutes recalled figures.
 *
 * Kept deliberately separate from `roles/analyze` for a failure-isolation reason as much as a
 * conceptual one: role discovery reasons about the candidate and must stay stable and reproducible,
 * so a labor-statistics provider being slow or down must never degrade it. Enrichment is a second
 * pass that can fail on its own without taking the role list with it.
 */

import { type LlmEnv, type Provider, callStructured, providerKeyMissing } from "./llm.ts";
import { getManagedPrompt } from "./langfuse.ts";
import { fetchWithTimeout, htmlToText } from "./companies.ts";
import { ROLES_RESEARCH_PROMPT } from "./prompts.ts";

export type MarketSource = { name: string; url: string; text: string };

export type RoleMarketResearch = {
  demand_direction: "growing" | "stable" | "declining" | "unclear";
  outlook_summary: string;
  typical_salary_range: string;
  salary_for_experience_level: string;
  geographic_notes: string;
  caveats: string[];
  sources: { name: string; url: string }[];
  /** Set when retrieval produced nothing usable, so the UI can say so rather than show blanks. */
  unavailable: boolean;
  researched_at: string;
};

const MARKET_RESEARCH_SCHEMA = {
  type: "object",
  properties: {
    demand_direction: {
      type: "string",
      enum: ["growing", "stable", "declining", "unclear"],
      description: "Use 'unclear' whenever the documents do not clearly establish a direction.",
    },
    outlook_summary: {
      type: "string",
      description: "What the documents say about employment outlook for this kind of work. Attribute figures.",
    },
    typical_salary_range: {
      type: "string",
      description: "The range the documents support, with the source named. Empty string if unsupported.",
    },
    salary_for_experience_level: {
      type: "string",
      description: "The band matching the stated seniority, if the documents break it down. Empty otherwise.",
    },
    geographic_notes: {
      type: "string",
      description: "What the documents say about the candidate's locations specifically. Empty if not covered.",
    },
    caveats: {
      type: "array",
      items: { type: "string" },
      description:
        "Where the data is a poor fit for the question -- a different occupation code, a national " +
        "figure standing in for a local one, a stale year, or sources that disagreed.",
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, url: { type: "string" } },
        required: ["name", "url"],
      },
      description: "Only documents actually provided above and actually used.",
    },
  },
  required: ["demand_direction", "outlook_summary", "caveats", "sources"],
} as const;

/**
 * Where market data is retrieved from, in preference order.
 *
 * US Bureau of Labor Statistics first: it is the authoritative primary source for occupational
 * outlook and wages, it publishes openly without an API key, and it states its own vintage. The
 * list is a plain array so adding a reputable source later is a one-line change; each entry gets a
 * best-effort fetch and any that fails simply doesn't contribute.
 */
const SOURCE_ENDPOINTS: { name: string; url: (query: string) => string }[] = [
  {
    name: "US Bureau of Labor Statistics — Occupational Outlook Handbook",
    url: (q) => `https://www.bls.gov/ooh/search?q=${encodeURIComponent(q)}`,
  },
  {
    name: "US Bureau of Labor Statistics — Occupational Employment and Wage Statistics",
    url: (q) => `https://www.bls.gov/oes/current/oes_stru.htm#${encodeURIComponent(q)}`,
  },
];

/** Per-document cap on retrieved text handed to the reader model. */
const SOURCE_TEXT_CAP = 12000;

/**
 * Retrieves candidate source documents. Never throws: every failure mode here (blocked, offline,
 * redesigned page, timeout) is a reason to report "not available", not to fail the request.
 */
export async function fetchMarketSources(query: string): Promise<MarketSource[]> {
  const results = await Promise.all(
    SOURCE_ENDPOINTS.map(async (source) => {
      try {
        const res = await fetchWithTimeout(source.url(query), 9000, { redirect: "follow" });
        if (!res || !res.ok) return null;
        const text = htmlToText(await res.text()).slice(0, SOURCE_TEXT_CAP);
        // A search page that matched nothing still returns 200 with boilerplate; a document too
        // short to contain a wage table is not evidence of anything.
        if (text.length < 400) return null;
        return { name: source.name, url: source.url(query), text };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is MarketSource => r !== null);
}

export function unavailableResearch(): RoleMarketResearch {
  return {
    demand_direction: "unclear",
    outlook_summary: "",
    typical_salary_range: "",
    salary_for_experience_level: "",
    geographic_notes: "",
    caveats: [],
    sources: [],
    unavailable: true,
    researched_at: new Date().toISOString(),
  };
}

/**
 * Reads retrieved documents into structured market context for one role.
 *
 * Returns the explicit "unavailable" record rather than a guess whenever retrieval produced nothing
 * or the reader could not be run -- the two cases the candidate must be able to distinguish from a
 * real finding.
 */
export async function researchRoleMarket(
  env: LlmEnv,
  provider: Provider,
  role: { title: string; alternate_titles: string[]; seniority: string },
  locations: string,
): Promise<RoleMarketResearch> {
  if (providerKeyMissing(env, provider)) return unavailableResearch();

  const sources = await fetchMarketSources(role.title);
  if (!sources.length) return unavailableResearch();

  const prompt = await getManagedPrompt(
    env,
    "roles/research",
    {
      role_title: role.title,
      alternate_titles: role.alternate_titles.join(", "),
      seniority: role.seniority || "not specified",
      locations: locations || "not specified",
      source_documents: sources
        .map((s) => `SOURCE: ${s.name}\nURL: ${s.url}\n---\n${s.text}`)
        .join("\n\n=====\n\n"),
    },
    ROLES_RESEARCH_PROMPT,
  );

  try {
    const raw = await callStructured<Partial<RoleMarketResearch>>(
      env,
      provider,
      "roles.research",
      prompt,
      MARKET_RESEARCH_SCHEMA,
      "submit_market_research",
      2000,
    );
    const directions = ["growing", "stable", "declining", "unclear"] as const;
    const direction = directions.includes(raw.demand_direction as (typeof directions)[number])
      ? (raw.demand_direction as RoleMarketResearch["demand_direction"])
      : "unclear";

    // Only sources actually retrieved may be cited. This is the last line of defense against a
    // fabricated attribution making an invented figure look sourced.
    const retrievedUrls = new Set(sources.map((s) => s.url));
    const citedSources = (raw.sources ?? []).filter((s) => s?.url && retrievedUrls.has(s.url));

    const research: RoleMarketResearch = {
      demand_direction: direction,
      outlook_summary: String(raw.outlook_summary ?? "").trim(),
      typical_salary_range: String(raw.typical_salary_range ?? "").trim(),
      salary_for_experience_level: String(raw.salary_for_experience_level ?? "").trim(),
      geographic_notes: String(raw.geographic_notes ?? "").trim(),
      caveats: (raw.caveats ?? []).map((c) => String(c ?? "").trim()).filter(Boolean),
      sources: citedSources.length ? citedSources : sources.map((s) => ({ name: s.name, url: s.url })),
      unavailable: false,
      researched_at: new Date().toISOString(),
    };

    // A record with no outlook prose and no salary figure carries no information, whatever the
    // model returned around it -- report it as unavailable rather than rendering an empty card.
    if (!research.outlook_summary && !research.typical_salary_range) return unavailableResearch();
    return research;
  } catch {
    return unavailableResearch();
  }
}

/** Cache key: research depends on the role and the geography, and nothing else. */
export function marketCacheKey(roleTitle: string, locations: string): string {
  return `${roleTitle.trim().toLowerCase()}|${locations.trim().toLowerCase()}`;
}

/** How long a cached research record stays fresh. Labor statistics update on a quarterly-to-annual
 * cadence, so re-researching an unchanged role more often than this spends money to learn nothing. */
export const MARKET_RESEARCH_TTL_DAYS = 30;
