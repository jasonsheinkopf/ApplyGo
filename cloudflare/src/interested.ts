// Interested + Improve redesign: pure helpers for turning Interested jobs' persisted requirement
// coverage (job_requirement_coverage, written by analyzeJobRequirementCoverage in src/index.ts)
// into deduplicated, prioritized context for the Profile > Improve audit prompt, and for linking a
// newly generated Improve question back to the jobs whose gap it answers.
//
// Deliberately has no D1/env dependency, unlike analyzeJobRequirementCoverage itself -- everything
// here is a pure function over already-loaded data, which is what makes it unit-testable the way
// the rest of this app's business logic (pipeline.ts, philosophy.ts, companystate.ts) already is.

export type InterestedJobGap = { requirement: string; kind: string; jobIds: string[]; jobLabels: string[] };

/** Loose text normalization for merging near-duplicate requirement phrasing across jobs without a
 * second LLM call just to cluster it -- see loadInterestedJobGaps' header comment for the tradeoff. */
export function requirementDedupeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Formats Interested-job gaps for the profile/improve-audit prompt, ranked so requirements shared
 * by the most jobs come first. Empty string when there are no Interested jobs (or none with a ready
 * analysis yet), which keeps Improve's general (job-agnostic) mode identical to before this feature
 * existed -- see prompts.ts's PROFILE_IMPROVE_AUDIT_PROMPT, which strips an empty variable's whole
 * line rather than leaving a blank "INTERESTED JOB GAPS" heading. */
export function renderJobRequirementContext(gaps: Map<string, InterestedJobGap>): string {
  if (!gaps.size) return "";
  const ranked = [...gaps.values()].sort((a, b) => b.jobIds.length - a.jobIds.length);
  const lines = ranked.slice(0, 40).map((gap) => {
    const names = gap.jobLabels.slice(0, 3).join(", ") + (gap.jobLabels.length > 3 ? ", ..." : "");
    const level = gap.kind === "must_have" ? "required" : "preferred/related";
    return `- "${gap.requirement}" (${level}) -- wanted by ${gap.jobIds.length} Interested role${gap.jobIds.length === 1 ? "" : "s"} (${names}); your profile does not clearly show this yet.`;
  });
  return [
    "INTERESTED JOB GAPS",
    "The candidate has marked the following jobs Interested. Their automatic requirement analysis",
    "found these gaps, ranked by how many Interested jobs share them -- weigh these heavily when",
    "choosing what to ask about, but every question must still be grounded in an actual entity in",
    "the career evidence record above, exactly as the rules below require. Do not ask about a gap",
    "here if the record has nothing plausibly related to attach the question to.",
    "",
    ...lines,
  ].join("\n");
}

const STOPWORDS = new Set(["the", "and", "with", "for", "this", "that", "have", "has", "your", "you", "about", "from", "into"]);

function significantTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
  );
}

/**
 * Best-effort link from a newly generated Improve question back to the Interested jobs whose gap it
 * most likely answers, purely from text overlap -- no extra LLM call for this either. Powers the
 * "N interested jobs" badge on a question card and the targeted reanalysis that runs after an
 * answer is applied (see applyImproveAnswers in src/index.ts). A miss here just means a question
 * doesn't get tagged; it is never the only place the question's own meaning lives, so a loose,
 * occasionally-wrong match is a fine tradeoff against a second LLM call.
 */
export function relatedJobIdsFor(
  question: { category: string; target_field: string; question: string },
  gaps: Map<string, InterestedJobGap>,
): string[] {
  const questionTokens = significantTokens(`${question.category} ${question.target_field} ${question.question}`);
  if (!questionTokens.size) return [];
  const related = new Set<string>();
  for (const gap of gaps.values()) {
    const gapTokens = significantTokens(gap.requirement);
    let overlap = 0;
    for (const token of gapTokens) if (questionTokens.has(token)) overlap += 1;
    // Requirement text is short (a few words), so any real overlap is meaningful; requiring only 1
    // token is deliberately loose -- a false positive just adds an extra job to a badge count, while
    // a false negative silently drops the whole point of linking the question back to its job(s).
    if (overlap > 0) for (const jobId of gap.jobIds) related.add(jobId);
  }
  return [...related];
}
