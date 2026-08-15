import assert from "node:assert/strict";
import test from "node:test";

import { filterJobsByRoles } from "./companies.ts";
import { unavailableResearch } from "./market.ts";

// ---------------------------------------------------------------------------
// Job title prefiltering
// ---------------------------------------------------------------------------

const jobs = [
  { external_id: "1", title: "Applied AI Engineer", url: "", location: "", posted_at: "", description: "" },
  { external_id: "2", title: "Staff Developer Advocate, Platform", url: "", location: "", posted_at: "", description: "" },
  { external_id: "3", title: "Senior Technical Trainer", url: "", location: "", posted_at: "", description: "" },
  { external_id: "4", title: "Warehouse Associate", url: "", location: "", posted_at: "", description: "" },
  { external_id: "5", title: "Oncology Nurse Practitioner", url: "", location: "", posted_at: "", description: "" },
];

const titlesOf = (list: typeof jobs) => list.map((j) => j.title);

test("explicit role-title terms keep plausible postings and drop irrelevant ones", () => {
  const kept = titlesOf(
    filterJobsByRoles(jobs, "", ["applied ai engineer", "developer advocate", "technical trainer"]),
  );
  assert.ok(kept.includes("Applied AI Engineer"));
  assert.ok(kept.includes("Senior Technical Trainer"));
  assert.ok(!kept.includes("Warehouse Associate"));
  assert.ok(!kept.includes("Oncology Nurse Practitioner"));
});

test("a decorated real-world title still passes the cheap filter", () => {
  // "Staff Developer Advocate, Platform" never equals the term exactly. The filter runs before any
  // model sees the posting, so its job is to drop the obviously irrelevant, not to be precise.
  const kept = titlesOf(filterJobsByRoles(jobs, "", ["developer advocate"]));
  assert.ok(kept.includes("Staff Developer Advocate, Platform"));
});

test("matching one role family is enough -- families do not have to agree", () => {
  const kept = titlesOf(
    filterJobsByRoles(jobs, "", ["applied ai engineer", "developer advocate", "technical trainer"]),
  );
  // Three unrelated career paths, three different postings surviving on their own merits.
  assert.equal(kept.length, 3);
});

test("alternate titles admit postings the canonical title alone would miss", () => {
  const withoutAlternates = titlesOf(filterJobsByRoles(jobs, "", ["applied ai engineer"]));
  assert.ok(!withoutAlternates.includes("Senior Technical Trainer"));

  const withAlternates = titlesOf(
    filterJobsByRoles(jobs, "", ["applied ai engineer", "technical trainer"]),
  );
  assert.ok(withAlternates.includes("Senior Technical Trainer"));
});

test("explicit terms take precedence over prose scraped from the flattened description", () => {
  // The prose mentions "warehouse" incidentally; explicit terms must not inherit that noise.
  const prose = "## Applied AI Engineer\\nNot a warehouse role, unlike warehouse logistics work.";
  const scraped = titlesOf(filterJobsByRoles(jobs, prose));
  assert.ok(scraped.includes("Warehouse Associate"), "precondition: prose scraping is noisy");

  const explicit = titlesOf(filterJobsByRoles(jobs, prose, ["applied ai engineer"]));
  assert.ok(!explicit.includes("Warehouse Associate"));
});

test("too few usable terms disables the filter rather than emptying the board", () => {
  // Recall-oriented by design: an under-specified analysis must not silently hide every posting.
  assert.equal(filterJobsByRoles(jobs, "", ["ai"]).length, jobs.length);
  assert.equal(filterJobsByRoles(jobs, "").length, jobs.length);
});

// ---------------------------------------------------------------------------
// Market research honesty
// ---------------------------------------------------------------------------

test("unavailable market research reports nothing rather than inventing figures", () => {
  const research = unavailableResearch();
  assert.equal(research.unavailable, true);
  assert.equal(research.typical_salary_range, "");
  assert.equal(research.salary_for_experience_level, "");
  assert.equal(research.outlook_summary, "");
  assert.equal(research.demand_direction, "unclear");
  assert.deepEqual(research.sources, []);
});
