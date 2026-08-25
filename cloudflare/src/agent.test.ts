import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOnboardingQuestions,
  emptyConfirmed,
  inferConfirmedFromExisting,
  injectAgentSettingsLink,
  mergeAgentPreferences,
  safeTextDocumentName,
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
