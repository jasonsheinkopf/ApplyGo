// The company pipeline's state model, and the invariants that keep it honest.
//
// A company has two independent states, not one:
//
//   identity    -- who is this employer, and do we know their real website?
//   jobSource   -- can we read their jobs, and if not, why not?
//
// They were previously one overloaded field, which is what produced the contradictions this module
// exists to make impossible: a row displaying a working Greenhouse board URL while simultaneously
// reporting "no job board found", and companies with confirmed websites filed under "Unverified"
// purely because their ATS wasn't one of the five ApplyGo can read.
//
// The rule that resolves it: **identity is about the company, jobSource is about our reach.** An
// unsupported ATS is a limitation of this app, not a defect in the employer, and the state model
// now says so.
//
// Everything here is pure. reconcileCompanyState is the single writer-side choke point: every path
// that persists a company runs its intended state through it first, so an illegal combination is
// corrected (and explained) at the point of write rather than papered over at render time.

export type IdentityStatus =
  /** Not yet attempted. */
  | "pending"
  /** We know their real website, with evidence. */
  | "verified"
  /** A candidate was found but could not be confirmed to be this company. Never auto-accepted. */
  | "ambiguous"
  /** Looked, found nothing credible. */
  | "unresolved"
  /** The "employer" was an ATS artifact ("Careers Listing"), not a company at all. */
  | "not_a_company"
  /** The user removed it. Orthogonal to everything else, and wins. */
  | "dismissed";

export type JobSourceStatus =
  /** Not yet attempted -- including because identity isn't verified yet. */
  | "pending"
  /** A board ApplyGo can actually read. */
  | "supported"
  /** A real board on a platform ApplyGo cannot read yet. Still worth a link. */
  | "unsupported_ats"
  /**
   * A real careers page exists, but no ATS could be identified behind it -- a proprietary or
   * client-rendered careers system. Distinct from no_board on purpose: the live data had nine rows
   * with a working careers URL filed as "no job board found", which is both false and unhelpful
   * when the URL itself is the useful thing to show.
   */
  | "careers_only"
  /** Site reachable, no hiring surface found on it at all. */
  | "no_board"
  /** A known board that failed to respond. Usually transient. */
  | "board_unreachable";

export type CompanyState = {
  identity: IdentityStatus;
  jobSource: JobSourceStatus;
  website: string;
  websiteConfidence: number | null;
  websiteEvidence: string;
  boardUrl: string;
  atsProvider: string;
  atsToken: string;
};

/** An identity state from which reading jobs is even meaningful. */
export function canHaveJobSource(identity: IdentityStatus): boolean {
  return identity === "verified";
}

/** Companies the pipeline should keep working on. */
export function isActiveIdentity(identity: IdentityStatus): boolean {
  return identity !== "dismissed" && identity !== "not_a_company";
}

/** Job sources whose jobs ApplyGo can actually import. */
export function isScannable(state: Pick<CompanyState, "identity" | "jobSource">): boolean {
  return state.identity === "verified" && state.jobSource === "supported";
}

/**
 * The invariants. Each returns a human-readable violation string, or null.
 *
 * These are assertions about states that must be unreachable, not validation of user input -- if
 * one fires, a writer built an impossible row and the bug is upstream. reconcileCompanyState
 * repairs rather than throws (a contradictory row must never take down a discovery run), but the
 * violation text is surfaced so it can be found and fixed.
 */
export function stateViolations(state: CompanyState): string[] {
  const problems: string[] = [];

  if (state.identity === "verified" && !state.website) {
    problems.push("identity is verified but no website is stored");
  }
  if (state.identity === "unresolved" && state.website) {
    problems.push("identity is unresolved but a website is stored");
  }
  // The exact contradiction from the reported UI: a board URL displayed next to "no job board".
  if (state.jobSource === "no_board" && state.boardUrl) {
    problems.push("job source says no_board but a board URL is stored");
  }
  if (state.jobSource === "unsupported_ats" && !state.atsProvider) {
    problems.push("job source says unsupported_ats but no ATS provider was identified");
  }
  if (state.jobSource === "careers_only" && !state.boardUrl) {
    problems.push("job source says careers_only but no careers/board URL is stored");
  }
  if (state.jobSource === "supported" && !state.atsProvider) {
    problems.push("job source says supported but no ATS provider was identified");
  }
  if (!canHaveJobSource(state.identity) && state.jobSource !== "pending") {
    problems.push(`job source is ${state.jobSource} but identity is ${state.identity}, which cannot have one`);
  }
  if (state.websiteConfidence !== null && (state.websiteConfidence < 0 || state.websiteConfidence > 100)) {
    problems.push(`website confidence ${state.websiteConfidence} is outside 0-100`);
  }
  return problems;
}

/**
 * Forces a state into a legal shape, preferring the *evidence* over the *label* whenever the two
 * disagree -- a stored board URL is a fact, "no_board" is an inference, so the URL wins and the
 * label is corrected. Returns the repaired state alongside whatever had to be fixed.
 *
 * Call this on every write path. It is the reason the contradictions above cannot reach the UI.
 */
export function reconcileCompanyState(input: CompanyState): { state: CompanyState; repaired: string[] } {
  const state: CompanyState = { ...input };
  const repaired: string[] = [];

  // Dismissed wins outright, but the evidence underneath is preserved so a re-add doesn't have to
  // re-resolve the company from scratch.
  if (state.identity === "dismissed") {
    if (state.jobSource !== "pending") {
      // Nothing to repair in the data -- a dismissed company simply isn't asked about job sources.
    }
    return { state, repaired };
  }

  if (state.identity === "verified" && !state.website) {
    state.identity = "unresolved";
    repaired.push("verified without a website -> unresolved");
  }
  if (state.identity === "unresolved" && state.website) {
    // A website is present, so this is at worst ambiguous, never "we found nothing".
    state.identity = "ambiguous";
    repaired.push("unresolved despite a stored website -> ambiguous");
  }

  // Job source only exists downstream of a verified identity.
  if (!canHaveJobSource(state.identity) && state.jobSource !== "pending") {
    repaired.push(`job source ${state.jobSource} on ${state.identity} identity -> pending`);
    state.jobSource = "pending";
  }

  // Evidence beats label: a real board URL cannot coexist with "no board found".
  if (state.jobSource === "no_board" && state.boardUrl) {
    // A known provider means an unsupported board; a URL with no provider means a careers page we
    // found but could not classify. Neither is "no board found".
    state.jobSource = state.atsProvider ? "unsupported_ats" : "careers_only";
    repaired.push(`no_board with a board URL -> ${state.jobSource}`);
  }
  if (state.jobSource === "careers_only" && !state.boardUrl) {
    state.jobSource = "no_board";
    repaired.push("careers_only with no URL -> no_board");
  }
  if (state.jobSource === "supported" && !state.atsProvider) {
    state.jobSource = state.boardUrl ? "careers_only" : "no_board";
    repaired.push(`supported without an ATS provider -> ${state.jobSource}`);
  }
  if (state.jobSource === "unsupported_ats" && !state.atsProvider && !state.boardUrl) {
    state.jobSource = "no_board";
    repaired.push("unsupported_ats with no provider and no URL -> no_board");
  }

  if (state.websiteConfidence !== null) {
    const clamped = Math.max(0, Math.min(100, Math.round(state.websiteConfidence)));
    if (clamped !== state.websiteConfidence) {
      repaired.push(`website confidence ${state.websiteConfidence} clamped to ${clamped}`);
      state.websiteConfidence = clamped;
    }
  }

  return { state, repaired };
}

/** Plain-language identity labels for the UI. One definition, used everywhere. */
export const IDENTITY_LABELS: Record<IdentityStatus, string> = {
  pending: "Not checked yet",
  verified: "Verified",
  ambiguous: "Ambiguous",
  unresolved: "Unresolved",
  not_a_company: "Not a company",
  dismissed: "Removed",
};

/** Plain-language job-source labels, phrased as a limitation of ApplyGo where that is the truth. */
export const JOB_SOURCE_LABELS: Record<JobSourceStatus, string> = {
  pending: "Not checked yet",
  supported: "Scannable",
  unsupported_ats: "Unsupported job board",
  careers_only: "Careers page only",
  no_board: "No job board found",
  board_unreachable: "Board unavailable",
};

/** Why a company sits where it does, for the detail view. */
export function explainState(state: Pick<CompanyState, "identity" | "jobSource" | "atsProvider">): string {
  switch (state.identity) {
    case "pending":
      return "Discovered from a real job posting. Identity has not been checked yet.";
    case "unresolved":
      return "No website could be confirmed for this company. It stays on the list and is retried automatically.";
    case "ambiguous":
      return "A possible website was found, but not with enough evidence to be sure it is this company rather than a similarly named one.";
    case "not_a_company":
      return "This employer field held a job-board page title rather than a company name.";
    case "dismissed":
      return "You removed this company.";
    case "verified":
      break;
  }
  switch (state.jobSource) {
    case "pending":
      return "Website confirmed. Its job board has not been checked yet.";
    case "supported":
      return "Website and job board confirmed. Jobs are imported from it automatically.";
    case "unsupported_ats":
      return `Website confirmed. They hire through ${state.atsProvider || "a system"} ApplyGo cannot read automatically yet -- use the board link to browse it directly.`;
    case "careers_only":
      return "Website and careers page confirmed, but the careers page does not run on a job-board system ApplyGo can read -- use the link to browse it directly.";
    case "no_board":
      return "Website confirmed, but no job board or careers page could be found on it.";
    case "board_unreachable":
      return "Website and job board confirmed, but reading the board failed. This is usually temporary and is retried.";
  }
}
