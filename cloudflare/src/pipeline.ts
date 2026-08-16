// The pipeline's numbers, defined exactly once.
//
// Every count the Companies and Jobs pages display comes from here. That is the entire point: the
// two pages previously computed overlapping metrics independently, so the diagram and the sentence
// underneath it could disagree, and "jobs waiting in Pre-screen" meant one thing on Companies and
// another on Jobs. A number with two implementations has two definitions, and one of them is wrong.
//
// Two rules this module exists to enforce:
//
// 1. **Stages reconcile.** Within one stage, the parts sum to the whole. Discovery's outcomes add
//    up to the companies discovered; identity's outcomes add up to identity's input. companyFunnel
//    returns the arithmetic already done, and pipelineInvariants asserts it.
//
// 2. **Units are never mixed.** Company stages count companies; job stages count jobs. The handoff
//    between them is an explicit boundary, not a subtraction -- one scannable company can yield
//    fifty jobs or none, so "37 companies -> 1,842 jobs" is a change of unit, not a flow that
//    conserves anything. Nothing here ever subtracts a job count from a company count.

/**
 * THE shared definition of "a job waiting in Pre-screen".
 *
 * Companies' final node and Jobs' first node are the same set of rows, so they are the same query,
 * written once. If this predicate changes, both pages change together and cannot drift apart.
 *
 * `company_id IS NOT NULL` is deliberate: these are jobs that came from a company the pipeline
 * imported, which is exactly what makes them the thing Companies hands to Jobs. A manually added
 * job is real and appears on the Jobs page, but it never flowed through company discovery, so
 * counting it in the handoff would make Companies claim credit for work it did not do.
 */
export const PRESCREEN_PREDICATE = "company_id IS NOT NULL AND fit_status = 'unassessed'";

/** The label both pages use for that set. One string, so they cannot disagree. */
export const PRESCREEN_LABEL = "Pre-screen";

/** Stage units, stated explicitly so a renderer can never imply a company became a job. */
export type StageUnit = "companies" | "jobs" | "postings";

export type FunnelOutcome = {
  id: string;
  label: string;
  count: number;
  kind: "success" | "pending" | "reject" | "partial";
};

export type FunnelStage = {
  id: string;
  label: string;
  unit: StageUnit;
  /** Total entering this stage. */
  total: number;
  /** Outcomes, which must sum to `total`. */
  outcomes: FunnelOutcome[];
};

export type CompanyCounts = {
  identity_pending: number;
  identity_verified: number;
  identity_ambiguous: number;
  identity_unresolved: number;
  identity_not_a_company: number;
  identity_dismissed: number;
  source_pending: number;
  source_supported: number;
  source_unsupported_ats: number;
  source_careers_only: number;
  source_no_board: number;
  source_board_unreachable: number;
  discovery_postings: number;
  total: number;
};

/**
 * The company funnel, as stages whose parts provably sum to their whole.
 *
 * Dismissed companies are excluded from every stage rather than shown as an outcome: removing a
 * company is a decision about the list, not a result the pipeline produced, and leaving them in
 * makes the totals move whenever someone tidies up.
 */
export function companyFunnel(counts: CompanyCounts): FunnelStage[] {
  const discovered =
    counts.identity_pending +
    counts.identity_verified +
    counts.identity_ambiguous +
    counts.identity_unresolved +
    counts.identity_not_a_company;

  const identityStage: FunnelStage = {
    id: "identity",
    label: "Identity",
    unit: "companies",
    total: discovered,
    outcomes: ([
      { id: "verified", label: "Verified", count: counts.identity_verified, kind: "success" },
      { id: "ambiguous", label: "Ambiguous", count: counts.identity_ambiguous, kind: "partial" },
      { id: "unresolved", label: "Unresolved", count: counts.identity_unresolved, kind: "reject" },
      { id: "not_a_company", label: "Not a company", count: counts.identity_not_a_company, kind: "reject" },
      { id: "identity_pending", label: "Not checked yet", count: counts.identity_pending, kind: "pending" },
    ] as FunnelOutcome[]).filter((o) => o.count > 0 || o.id === "verified"),
  };

  // Only verified companies reach this stage, which is why its total is the verified count and not
  // the discovered count. Stating that here is what keeps the arithmetic honest.
  const jobSourceStage: FunnelStage = {
    id: "job_source",
    label: "Job source",
    unit: "companies",
    total: counts.identity_verified,
    outcomes: ([
      { id: "supported", label: "Scannable", count: counts.source_supported, kind: "success" },
      { id: "unsupported_ats", label: "Unsupported board", count: counts.source_unsupported_ats, kind: "partial" },
      { id: "careers_only", label: "Careers page only", count: counts.source_careers_only, kind: "partial" },
      { id: "no_board", label: "No job board", count: counts.source_no_board, kind: "reject" },
      { id: "board_unreachable", label: "Board unavailable", count: counts.source_board_unreachable, kind: "reject" },
      { id: "source_pending", label: "Not checked yet", count: counts.source_pending, kind: "pending" },
    ] as FunnelOutcome[]).filter((o) => o.count > 0 || o.id === "supported"),
  };

  return [identityStage, jobSourceStage];
}

/**
 * Checks the arithmetic a renderer is about to draw. Returns human-readable problems, empty when
 * everything reconciles.
 *
 * This exists because a funnel that does not add up is worse than no funnel: it looks authoritative
 * while being wrong, and the reader has no way to tell. Tested directly, and cheap enough to run
 * behind the scenes on real data.
 */
export function funnelViolations(stages: FunnelStage[]): string[] {
  const problems: string[] = [];
  for (const stage of stages) {
    const summed = stage.outcomes.reduce((acc, o) => acc + o.count, 0);
    if (summed !== stage.total) {
      problems.push(`stage "${stage.label}": outcomes sum to ${summed} but ${stage.total} entered`);
    }
    if (stage.outcomes.some((o) => o.count < 0)) {
      problems.push(`stage "${stage.label}": has a negative outcome count`);
    }
  }
  // A later stage can never take in more than an earlier stage let through.
  for (let i = 1; i < stages.length; i += 1) {
    if (stages[i].unit !== stages[i - 1].unit) continue;
    const upstreamSuccess = stages[i - 1].outcomes
      .filter((o) => o.kind === "success")
      .reduce((acc, o) => acc + o.count, 0);
    if (stages[i].total > upstreamSuccess) {
      problems.push(
        `stage "${stages[i].label}" takes in ${stages[i].total} but "${stages[i - 1].label}" only passed ${upstreamSuccess}`,
      );
    }
  }
  return problems;
}

/**
 * The company -> jobs handoff. Deliberately its own type rather than another FunnelStage, because
 * it is the one place the unit changes and nothing about it conserves a quantity.
 */
export type Handoff = {
  fromLabel: string;
  fromCount: number;
  fromUnit: StageUnit;
  toLabel: string;
  toCount: number;
  toUnit: StageUnit;
};

export function companyToJobHandoff(counts: CompanyCounts, prescreenJobs: number): Handoff {
  return {
    fromLabel: "Scannable companies",
    fromCount: counts.source_supported,
    fromUnit: "companies",
    toLabel: PRESCREEN_LABEL,
    toCount: prescreenJobs,
    toUnit: "jobs",
  };
}

/**
 * One run-status sentence, built from the same numbers the diagram draws, with every figure carrying
 * its unit. Replaces the long free-text summary that restated the funnel in prose and could disagree
 * with it.
 */
export function runSummaryLine(counts: CompanyCounts, prescreenJobs: number, running: boolean): string {
  const discovered =
    counts.identity_pending + counts.identity_verified + counts.identity_ambiguous +
    counts.identity_unresolved + counts.identity_not_a_company;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    plural(discovered, "company", "companies"),
    `${counts.identity_verified} verified`,
    `${plural(prescreenJobs, "job", "jobs")} ready for pre-screen`,
  ];
  return `${running ? "Discovery running" : "Completed"} · ${parts.join(" · ")}`;
}
