import assert from "node:assert/strict";
import test from "node:test";

import {
  CAREER_PROFILE_SCHEMA,
  CAREER_PROFILE_SCHEMA_VERSION,
  IMPROVE_AUDIT_SCHEMA,
  buildMatchProfile,
  careerProfileHasContent,
  isLegacyProfileShape,
  isValidProfileEntity,
  legacyToCareerProfile,
  listProfileEntities,
  normalizeCareerProfile,
  normalizeImproveQuestions,
  profileEvidenceStrings,
  readCareerProfile,
  renderCareerProfile,
} from "./profile.ts";
import { getManagedPrompt } from "./langfuse.ts";
import {
  PROFILE_CREATE_PROMPT,
  PROFILE_IMPROVE_APPLY_PROMPT,
  PROFILE_IMPROVE_AUDIT_PROMPT,
  ROLES_ANALYZE_PROMPT,
} from "./prompts.ts";

// ---------------------------------------------------------------------------
// Schema and normalization
// ---------------------------------------------------------------------------

test("normalization fills every section so consumers never need optional chaining", () => {
  const profile = normalizeCareerProfile({});
  assert.equal(profile.schema_version, CAREER_PROFILE_SCHEMA_VERSION);
  assert.deepEqual(profile.work_experience, []);
  assert.deepEqual(profile.education, []);
  assert.deepEqual(profile.technical_skills, []);
  assert.deepEqual(profile.evidence_gaps, []);
  assert.equal(profile.career_summary.headline, "");
  assert.equal(profile.identity.name, "");
});

test("the structured-output schema only hard-requires the summary, so empty sections stay legal", () => {
  // Requiring deep sections is what makes a model pad them with invented filler.
  assert.deepEqual([...CAREER_PROFILE_SCHEMA.required], ["career_summary"]);
  assert.deepEqual([...CAREER_PROFILE_SCHEMA.properties.career_summary.required], ["headline", "narrative_summary"]);
});

test("entries with no identifying content are dropped rather than kept as empty shells", () => {
  const profile = normalizeCareerProfile({
    work_experience: [{ organization: "Acme", title: "Engineer" }, {}, { description: "orphan" }],
    education: [{ institution: "State" }, {}],
  });
  assert.equal(profile.work_experience.length, 1);
  assert.equal(profile.education.length, 1);
});

test("'Present' in end_date is understood as the current role however the model spelled it", () => {
  const profile = normalizeCareerProfile({
    work_experience: [{ organization: "Acme", title: "Engineer", end_date: "Present" }],
  });
  assert.equal(profile.work_experience[0].current, true);
});

test("aggregate sections deduplicate case-insensitively and keep their evidence", () => {
  const profile = normalizeCareerProfile({
    technical_skills: [
      { skill: "Python", evidence: ["Pipeline at Acme"] },
      { skill: "python", evidence: ["ignored duplicate"] },
      { skill: "" },
    ],
  });
  assert.equal(profile.technical_skills.length, 1);
  assert.deepEqual(profile.technical_skills[0].evidence, ["Pipeline at Acme"]);
});

test("provenance is preserved: work stays attached to the role it happened in", () => {
  const profile = normalizeCareerProfile({
    work_experience: [
      {
        organization: "Acme",
        title: "Engineer",
        mentoring_and_teaching: ["Onboarded six engineers"],
        projects: [{ name: "Migration", metrics: ["6h to 40min"] }],
      },
    ],
  });
  const role = profile.work_experience[0];
  assert.deepEqual(role.mentoring_and_teaching, ["Onboarded six engineers"]);
  assert.deepEqual(role.projects[0].metrics, ["6h to 40min"]);
});

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

const LEGACY = {
  headline: "Data Engineer",
  narrative_summary: "Builds pipelines.",
  experience: [{ company: "Acme", title: "Engineer", start: "2020", end: "Present", highlights: ["Ran the migration"] }],
  education: [{ school: "State University", degree: "BS", field: "CS", start_year: "2014", end_year: "2018" }],
  skills: ["Python", "SQL"],
};

test("a stored legacy profile is detected and loads without crashing", () => {
  assert.equal(isLegacyProfileShape(LEGACY as Record<string, unknown>), true);
  const profile = readCareerProfile(JSON.stringify(LEGACY));
  assert.ok(profile);
  assert.equal(profile.career_summary.headline, "Data Engineer");
  assert.equal(profile.work_experience[0].organization, "Acme");
  assert.equal(profile.education[0].institution, "State University");
  assert.deepEqual(profile.technical_skills.map((s) => s.name), ["Python", "SQL"]);
});

test("legacy conversion invents no structure it cannot justify", () => {
  // A legacy highlight is an undifferentiated resume bullet. Promoting it to an achievement or a
  // project would write fabricated categorization into the canonical record.
  const profile = legacyToCareerProfile(LEGACY);
  const role = profile.work_experience[0];
  assert.deepEqual(role.responsibilities, ["Ran the migration"]);
  assert.deepEqual(role.achievements, []);
  assert.deepEqual(role.projects, []);
  assert.deepEqual(profile.career_signals, []);
});

test("a converted legacy record is marked as legacy, not as a genuine current-schema profile", () => {
  assert.equal(legacyToCareerProfile(LEGACY).schema_version, 1);
  assert.equal(normalizeCareerProfile({}).schema_version, CAREER_PROFILE_SCHEMA_VERSION);
});

test("a new-schema profile is not mistaken for a legacy one", () => {
  const current = normalizeCareerProfile({ career_summary: { headline: "X", narrative_summary: "Y" } });
  assert.equal(isLegacyProfileShape(current as unknown as Record<string, unknown>), false);
  assert.equal(readCareerProfile(JSON.stringify(current))?.career_summary.headline, "X");
});

test("empty and malformed stored profiles read as 'no profile' rather than throwing", () => {
  assert.equal(readCareerProfile(""), null);
  assert.equal(readCareerProfile("{}"), null);
  assert.equal(readCareerProfile("not json"), null);
  assert.equal(careerProfileHasContent(normalizeCareerProfile({})), false);
});

// ---------------------------------------------------------------------------
// Renderings
// ---------------------------------------------------------------------------

const RICH = normalizeCareerProfile({
  career_summary: { headline: "Applied AI Engineer", narrative_summary: "Ships LLM features." },
  work_experience: [
    {
      organization: "Acme",
      title: "Engineer",
      start_date: "2020",
      current: true,
      responsibilities: ["Owned the retrieval service"],
      mentoring_and_teaching: ["Mentored three juniors"],
      stakeholder_and_client_work: ["Ran customer workshops"],
      projects: [
        {
          name: "RAG rollout",
          work_performed: ["Built the eval harness"],
          technologies_and_methods: ["Python", "pgvector"],
          metrics: ["latency down 45%"],
        },
      ],
      achievements: [{ description: "Cut infra spend", metrics: ["$120k/yr"] }],
    },
  ],
  education: [{ institution: "State University", degree: "BS", field_of_study: "CS" }],
  technical_skills: [{ skill: "Python", evidence: ["RAG rollout"] }],
  tools_and_technologies: [{ name: "pgvector", evidence: [] }],
  domain_knowledge: [{ domain: "Healthcare", evidence: [] }],
});

test("the full rendering keeps the evidence career analysis depends on", () => {
  const rendered = renderCareerProfile(RICH);
  for (const expected of [
    "Mentored three juniors",
    "Ran customer workshops",
    "Built the eval harness",
    "latency down 45%",
    "Cut infra spend",
  ]) {
    assert.ok(rendered.includes(expected), `full rendering dropped: ${expected}`);
  }
});

test("the compact match profile stays small, which is exactly why it must not feed role analysis", () => {
  const compact = buildMatchProfile(RICH);
  assert.ok(compact.length <= 2000);
  assert.ok(compact.includes("Applied AI Engineer"));
  assert.ok(compact.includes("Python"));
  // The detail that makes a non-obvious career path discoverable is absent here by design.
  assert.ok(!compact.includes("Mentored three juniors"));
  assert.ok(!compact.includes("Ran customer workshops"));
  assert.ok(renderCareerProfile(RICH).length > compact.length);
});

test("match profile of a missing profile is empty rather than a crash", () => {
  assert.equal(buildMatchProfile(null), "");
});

test("grounding evidence spans nested project and achievement text, not just headings", () => {
  const evidence = profileEvidenceStrings(RICH);
  assert.ok(evidence.includes("Built the eval harness"));
  assert.ok(evidence.includes("latency down 45%"));
  assert.ok(evidence.includes("Cut infra spend"));
  assert.ok(evidence.includes("Acme"));
});

// ---------------------------------------------------------------------------
// Prompt compatibility
// ---------------------------------------------------------------------------

async function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

/**
 * A distinct base URL per test. getManagedPrompt memoizes per (host, key, prompt name) for five
 * minutes, so tests sharing one host would hand each other cached prompts -- and the compatibility
 * check deliberately re-evaluates cached copies too, which is correct in production and confusing
 * in a test suite.
 */
function langfuseEnv(scope: string) {
  return {
    LANGFUSE_PUBLIC_KEY: "pk",
    LANGFUSE_SECRET_KEY: "sk",
    LANGFUSE_BASE_URL: `https://${scope}.test.invalid`,
  };
}

test("a Langfuse prompt predating the schema v3 rename is not left silently active", async () => {
  // A template that references none of the current contract's variables -- e.g. one still built
  // around a since-retired {{baseline_rule}} -- must not run as-is: compiling it would succeed and
  // produce a model told to build the old thing under the new schema.
  const stale = "Build a profile from {{baseline_rule}} only.";
  const prompt = await withFetch(
    async () => Response.json({ id: "p", name: "profile/create", version: 4, type: "text", prompt: stale }),
    () =>
      getManagedPrompt(
        langfuseEnv("stale"),
        "profile/create",
        { baseline_rule: "", current_profile: "", source_material: "CV text", previous_entity_ids: "" },
        PROFILE_CREATE_PROMPT,
      ),
  );
  assert.match(prompt.name, /bundled default/);
  assert.ok(prompt.text.includes("CAREER EVIDENCE RECORD"));
  assert.ok(prompt.text.includes("CV text"));
});

test("a compatible Langfuse prompt still wins over the bundled default", async () => {
  const current = "Use {{source_material}}, {{current_profile}} and {{previous_entity_ids}}.";
  const prompt = await withFetch(
    async () => Response.json({ id: "p", name: "profile/create", version: 9, type: "text", prompt: current }),
    () =>
      getManagedPrompt(
        langfuseEnv("current"),
        "profile/create",
        { current_profile: "prev", source_material: "CV text", previous_entity_ids: "work_acme_2020 — Acme" },
        PROFILE_CREATE_PROMPT,
      ),
  );
  assert.equal(prompt.name, "profile/create");
  assert.equal(prompt.version, 9);
  assert.equal(prompt.text, "Use CV text, prev and work_acme_2020 — Acme.");
});

test("the bundled default covers Langfuse being unreachable entirely", async () => {
  const prompt = await withFetch(
    async () => {
      throw new Error("network down");
    },
    () =>
      getManagedPrompt(
        langfuseEnv("offline"),
        "roles/analyze",
        {
          candidate_background: "BG",
          notes_and_links: "",
          good_examples: "GOOD-EXAMPLE-BLOCK",
          bad_examples: "",
          locations: "",
          dealbreakers: "",
          criteria: "",
        },
        ROLES_ANALYZE_PROMPT,
      ),
  );
  assert.match(prompt.name, /bundled default/);
  assert.ok(prompt.text.includes("GOOD-EXAMPLE-BLOCK"));
});

test("the roles/analyze contract actually consumes the good/bad example variables", () => {
  // The bug this refactor had to fix: the backend passed these and the production prompt ignored
  // them, so examples were collected and then silently discarded.
  assert.ok(ROLES_ANALYZE_PROMPT.text.includes("{{good_examples}}"));
  assert.ok(ROLES_ANALYZE_PROMPT.text.includes("{{bad_examples}}"));
  assert.ok(ROLES_ANALYZE_PROMPT.requires.includes("good_examples"));
  assert.ok(ROLES_ANALYZE_PROMPT.requires.includes("bad_examples"));
});

test("every variable a bundled prompt references is one its contract declares supplied", () => {
  for (const prompt of [PROFILE_CREATE_PROMPT, PROFILE_IMPROVE_AUDIT_PROMPT, PROFILE_IMPROVE_APPLY_PROMPT, ROLES_ANALYZE_PROMPT]) {
    const referenced = new Set(
      Array.from(prompt.text.matchAll(/{{\s*([A-Za-z_]+)\s*}}/g), (match) => match[1]),
    );
    assert.ok(referenced.size > 0);
    for (const name of prompt.requires) {
      assert.ok(referenced.has(name), `${name} is declared required but never referenced`);
    }
  }
});

// ---------------------------------------------------------------------------
// Stable entity ids (schema v3)
// ---------------------------------------------------------------------------

test("every major repeatable entity gets a stable, readable id", () => {
  const profile = normalizeCareerProfile({
    work_experience: [{
      organization: "Bosch",
      title: "AI Engineer",
      start_date: "2024",
      current: true,
      projects: [{ name: "Vehicle Personalization" }],
      achievements: [{ description: "Shipped the prototype to production" }],
    }],
    education: [{ institution: "Georgia Tech", degree: "MS", end_date: "2019" }],
    independent_projects: [{ name: "Open source linter", dates: "2022" }],
    research_and_publications: [{ title: "A Paper", date: "2021" }],
  });
  assert.match(profile.work_experience[0].id, /^work_bosch_ai_engineer_2024$/);
  assert.match(profile.work_experience[0].projects[0].id, /^project_vehicle_personalization$/);
  assert.match(profile.work_experience[0].achievements[0].id, /^achievement_/);
  assert.match(profile.education[0].id, /^education_georgia_tech_ms_2019$/);
  assert.match(profile.independent_projects[0].id, /^independent_open_source_linter_2022$/);
  assert.match(profile.research_and_publications[0].id, /^research_a_paper_2021$/);
});

test("an id supplied by the model (e.g. reused from a previous generation) is kept as-is", () => {
  const profile = normalizeCareerProfile({
    work_experience: [{ id: "work_bosch_ai_engineer_2024", organization: "Bosch", title: "AI Engineer" }],
  });
  assert.equal(profile.work_experience[0].id, "work_bosch_ai_engineer_2024");
});

test("colliding ids within one generation get a stable numeric tail instead of overwriting each other", () => {
  const profile = normalizeCareerProfile({
    work_experience: [
      { organization: "Acme", title: "Engineer" },
      { organization: "Acme", title: "Engineer" },
    ],
  });
  const ids = profile.work_experience.map((e) => e.id);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids[1].endsWith("_2"));
});

test("a v2 profile (no ids at all) reads as v3 with fresh ids minted rather than losing entries", () => {
  const v2 = {
    schema_version: 2,
    career_summary: { headline: "Engineer", narrative_summary: "Builds things." },
    work_experience: [{ organization: "Acme", title: "Engineer", projects: [{ name: "Migration" }] }],
  };
  const upgraded = readCareerProfile(JSON.stringify(v2));
  assert.ok(upgraded);
  assert.equal(upgraded.schema_version, CAREER_PROFILE_SCHEMA_VERSION);
  assert.equal(upgraded.work_experience.length, 1);
  assert.ok(upgraded.work_experience[0].id);
  assert.ok(upgraded.work_experience[0].projects[0].id);
});

test("the new evidence dimensions and the other[] escape hatch normalize like any other list", () => {
  const profile = normalizeCareerProfile({
    work_experience: [{
      organization: "Acme",
      title: "Engineer",
      projects: [{
        name: "Rollout",
        collaborators_and_stakeholders: ["Japan team", "Germany team"],
        scope_and_scale: ["4 regions"],
        constraints_and_challenges: ["Tight deadline"],
        decisions_enabled: ["Greenlit the MVP"],
        recognition: ["Team award"],
        other: ["Presented at all-hands"],
      }],
    }],
  });
  const project = profile.work_experience[0].projects[0];
  assert.deepEqual(project.collaborators_and_stakeholders, ["Japan team", "Germany team"]);
  assert.deepEqual(project.scope_and_scale, ["4 regions"]);
  assert.deepEqual(project.decisions_enabled, ["Greenlit the MVP"]);
  assert.deepEqual(project.other, ["Presented at all-hands"]);
});

// ---------------------------------------------------------------------------
// Improve workflow: entity lookup and question validation
// ---------------------------------------------------------------------------

const IMPROVE_PROFILE = normalizeCareerProfile({
  career_summary: { headline: "Engineer", narrative_summary: "Builds things." },
  work_experience: [{
    id: "work_bosch_ai_engineer_2024",
    organization: "Bosch",
    title: "AI Engineer",
    projects: [{ id: "project_vehicle_personalization", name: "Vehicle Personalization" }],
  }],
});

test("listProfileEntities enumerates every id-bearing entity plus the whole-profile target", () => {
  const entities = listProfileEntities(IMPROVE_PROFILE);
  const byId = Object.fromEntries(entities.map((e) => [e.entity_id, e]));
  assert.equal(byId["work_bosch_ai_engineer_2024"].entity_type, "work_experience");
  assert.equal(byId["project_vehicle_personalization"].entity_type, "work_experience_project");
  assert.ok(entities.some((e) => e.entity_type === "profile"));
});

test("isValidProfileEntity accepts real entities and the whole-profile target, rejects hallucinated ids", () => {
  assert.equal(isValidProfileEntity(IMPROVE_PROFILE, "work_experience", "work_bosch_ai_engineer_2024"), true);
  assert.equal(isValidProfileEntity(IMPROVE_PROFILE, "profile", ""), true);
  assert.equal(isValidProfileEntity(IMPROVE_PROFILE, "work_experience", "work_nonexistent_2099"), false);
});

test("normalizeImproveQuestions drops any question pointing at an entity the profile doesn't have", () => {
  const questions = normalizeImproveQuestions(
    [
      { priority: 90, category: "outcome", entity_type: "work_experience_project", entity_id: "project_vehicle_personalization", question: "Real question", why_it_matters: "x" },
      { priority: 95, category: "outcome", entity_type: "work_experience", entity_id: "work_totally_made_up", question: "Hallucinated question", why_it_matters: "x" },
      { priority: 50, category: "identity", entity_type: "profile", entity_id: "", question: "Whole-profile question", why_it_matters: "x" },
    ],
    IMPROVE_PROFILE,
  );
  assert.equal(questions.length, 2);
  assert.ok(questions.every((q) => q.question !== "Hallucinated question"));
  assert.ok(questions.every((q) => q.id.startsWith("q_")));
});

test("normalizeImproveQuestions sorts by priority and caps at 30", () => {
  const raw = Array.from({ length: 40 }, (_, i) => ({
    priority: i,
    category: "other",
    entity_type: "profile",
    entity_id: "",
    question: `Question ${i}`,
    why_it_matters: "x",
  }));
  const questions = normalizeImproveQuestions(raw, IMPROVE_PROFILE);
  assert.equal(questions.length, 30);
  assert.equal(questions[0].question, "Question 39");
  assert.ok(questions[0].priority >= questions[questions.length - 1].priority);
});

test("the improve-audit structured-output schema only hard-requires the fields validation depends on", () => {
  assert.deepEqual([...IMPROVE_AUDIT_SCHEMA.required], ["questions"]);
});
