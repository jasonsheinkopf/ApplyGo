import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOnboardingQuestions,
  emptyConfirmed,
  inferConfirmedFromExisting,
  injectAgentSettingsLink,
  mergeAgentPreferences,
  newlyDiscoveredJobs,
  safeTextDocumentName,
  shapeShortlist,
  summarizeLegacyBody,
  toCompanyCounts,
} from "./agent.ts";

test("a fresh interview asks every onboarding topic in the intended order", () => {
  const questions = buildOnboardingQuestions(emptyConfirmed());
  assert.deepEqual(questions.map((q) => q.topic), [
    "resume",
    "career_direction",
    "locations",
    "dealbreakers",
    "priorities",
    "extra_evidence",
  ]);
});

test("existing ApplyGo data can seed a continue interview without treating blank optional answers as confirmed", () => {
  const confirmed = inferConfirmedFromExisting({
    documentCount: 2,
    careerPreferenceCount: 1,
    noteCount: 3,
    desiredLocations: "California, Remote",
    dealbreakers: "",
    careAbout: "Compensation and remote policy",
  });
  assert.equal(confirmed.resume, true);
  assert.equal(confirmed.career_direction, true);
  assert.equal(confirmed.locations, true);
  assert.equal(confirmed.dealbreakers, false);
  assert.equal(confirmed.priorities, true);
  assert.equal(confirmed.extra_evidence, true);
  assert.deepEqual(buildOnboardingQuestions(confirmed).map((q) => q.topic), ["dealbreakers"]);
});

test("preference merge preserves unrelated settings and invalidates derived role analysis", () => {
  const { preferences, changed } = mergeAgentPreferences(
    {
      desired_locations: "Bay Area",
      dealbreakers: "No relocation",
      care_about: "Salary",
      care_about_topics: [{ label: "Salary" }],
      role_analysis: { roles: [{ title: "AI Engineer" }] },
      desired_roles: "AI Engineer",
      match_threshold: 72,
    },
    { desired_locations: "California", care_about: "Salary and remote policy" },
  );
  assert.deepEqual(changed, ["desired_locations", "care_about"]);
  assert.equal(preferences.desired_locations, "California");
  assert.equal(preferences.care_about, "Salary and remote policy");
  assert.equal(preferences.dealbreakers, "No relocation");
  assert.equal(preferences.match_threshold, 72);
  assert.equal("role_analysis" in preferences, false);
  assert.equal("desired_roles" in preferences, false);
  assert.equal("care_about_topics" in preferences, false);
});

test("confirming an unchanged preference does not erase valid derived data", () => {
  const roleAnalysis = { roles: [{ title: "AI Engineer" }] };
  const { preferences, changed } = mergeAgentPreferences(
    { desired_locations: "California", role_analysis: roleAnalysis, desired_roles: "AI Engineer" },
    { desired_locations: "California" },
  );
  assert.deepEqual(changed, []);
  assert.deepEqual(preferences.role_analysis, roleAnalysis);
  assert.equal(preferences.desired_roles, "AI Engineer");
});

test("text document names are safe and accurately identify text content", () => {
  assert.equal(safeTextDocumentName("Jason Resume.pdf"), "Jason Resume.txt");
  assert.equal(safeTextDocumentName("../../resume\0.docx"), "..-..-resume-.txt");
  assert.equal(safeTextDocumentName("notes.txt"), "notes.txt");
});

test("settings link injection is targeted and idempotent", () => {
  const marker = '<div id="devices-list"><p class="empty">Loading…</p></div>';
  const first = injectAgentSettingsLink(`<section>${marker}</section>`);
  assert.match(first, /id="agent-access-link"/);
  assert.equal(injectAgentSettingsLink(first), first);
  assert.equal(injectAgentSettingsLink("<section>other page</section>"), "<section>other page</section>");
});

test("toCompanyCounts fills every field the funnel needs, defaulting anything missing to zero", () => {
  const counts = toCompanyCounts({ identity_verified: 12, source_supported: 5 });
  assert.equal(counts.identity_verified, 12);
  assert.equal(counts.source_supported, 5);
  assert.equal(counts.identity_pending, 0);
  assert.equal(counts.discovery_postings, 0);
  assert.equal(counts.total, 0);
});

test("shapeShortlist keeps only strong/possible jobs at or above the score floor, best first, with rationale attached", () => {
  const jobs = [
    { id: "1", title: "AI Engineer", company: "Acme", fit_status: "strong", fit_score: 82, fit_reason: "Strong overlap", fit_missing_json: "[]", source_url: "https://acme.example/1" },
    { id: "2", title: "Data Scientist", company: "Beta", fit_status: "possible", fit_score: 55, fit_reason: "Stretch on seniority", fit_missing_json: '["5+ years"]' },
    { id: "3", title: "Recruiter", company: "Gamma", fit_status: "reject", fit_score: 90, fit_reason: "Wrong profession" },
    { id: "4", title: "ML Engineer", company: "Delta", fit_status: "possible", fit_score: 30, fit_reason: "Below floor" },
  ];
  const shortlist = shapeShortlist(jobs, 40, 10);
  assert.deepEqual(shortlist.map((j) => j.id), ["1", "2"]);
  assert.equal(shortlist[0].fit_score, 82);
  assert.deepEqual(shortlist[1].missing, ["5+ years"]);
  assert.equal(shortlist[0].url, "https://acme.example/1");
});

test("shapeShortlist respects the limit after sorting", () => {
  const jobs = [
    { id: "1", fit_status: "strong", fit_score: 60 },
    { id: "2", fit_status: "strong", fit_score: 90 },
    { id: "3", fit_status: "strong", fit_score: 75 },
  ];
  assert.deepEqual(shapeShortlist(jobs, 0, 2).map((j) => j.id), ["2", "3"]);
});

test("newlyDiscoveredJobs keeps only rows created at or after the watermark", () => {
  const jobs = [
    { id: "1", created_at: "2026-08-25T10:00:00Z" },
    { id: "2", created_at: "2026-08-26T09:00:00Z" },
    { id: "3", created_at: "2026-08-26T09:00:01Z" },
  ];
  assert.deepEqual(newlyDiscoveredJobs(jobs, "2026-08-26T09:00:00Z").map((j) => j.id), ["2", "3"]);
});

test("summarizeLegacyBody passes a plain JSON object through unchanged", () => {
  assert.deepEqual(summarizeLegacyBody('{"saved":true,"id":"abc"}'), { saved: true, id: "abc" });
});

test("summarizeLegacyBody falls back to a raw excerpt for unparseable single-line bodies", () => {
  assert.deepEqual(summarizeLegacyBody("not json"), { raw: "not json" });
});

test("summarizeLegacyBody tallies an NDJSON progress stream into counts, errors, and the final event", () => {
  const body = [
    JSON.stringify({ type: "pipeline", stage: "screen", phase: "dispatched", ids: ["a", "b"] }),
    JSON.stringify({ type: "pipeline", stage: "screen", phase: "done", ids: ["a", "b"] }),
    JSON.stringify({ type: "pipeline", stage: "assess", phase: "failed", ids: ["c"] }),
    JSON.stringify({ type: "done", screened: 2, screenedOut: 0, assessed: 1, errors: 1 }),
  ].join("\n");
  const summary = summarizeLegacyBody(body);
  assert.equal(summary.total_events, 4);
  assert.deepEqual(summary.event_counts, {
    "pipeline.screen.dispatched": 1,
    "pipeline.screen.done": 1,
    "pipeline.assess.failed": 1,
    done: 1,
  });
  assert.equal((summary.errors as unknown[]).length, 1);
  assert.deepEqual(summary.final_event, { type: "done", screened: 2, screenedOut: 0, assessed: 1, errors: 1 });
});

test("summarizeLegacyBody tolerates one malformed line in an otherwise real NDJSON stream", () => {
  const body = ['{"type":"a"}', "not json", '{"type":"b"}'].join("\n");
  const summary = summarizeLegacyBody(body);
  assert.equal(summary.total_events, 2);
});
