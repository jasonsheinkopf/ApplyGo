import assert from "node:assert/strict";
import test from "node:test";

import {
  type JobEvidenceAnalysis,
  coverageCounts,
  normalizeStrengthenQuestions,
  readJobEvidenceAnalysis,
  renderCoverLetterEvidence,
  renderCoverageForQuestions,
  renderPriorQuestionState,
} from "./strengthen.ts";
import {
  normalizePlan,
  normalizeRequirements,
  renderPlanDirective,
  requirementVocabularyPresent,
} from "./philosophy.ts";
import { normalizeCareerProfile } from "./profile.ts";
import { getManagedPrompt } from "./langfuse.ts";
import { COVER_LETTER_COMPOSE_PROMPT, STRENGTHEN_QUESTIONS_PROMPT } from "./prompts.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A candidate whose visualization experience is Plotly, never D3. This specific shape is what the
 * truthfulness tests below turn on: the profile is *adjacent* to what the posting wants, which is
 * the case where a system that matches on vibes rather than evidence quietly invents a
 * qualification.
 */
function profileFixture() {
  return normalizeCareerProfile({
    identity: { name: "Test Candidate" },
    work_experience: [
      {
        id: "work_bosch_ai_engineer_2024",
        organization: "Bosch",
        title: "AI Engineer",
        projects: [
          {
            id: "project_vehicle_personalization",
            name: "Vehicle personalization prototype",
            description: "Built a personalization prototype for in-vehicle settings using PyTorch.",
            technologies: ["PyTorch", "Python"],
          },
        ],
        achievements: [
          {
            id: "achievement_plotly_dashboard",
            description: "Created interactive Plotly dashboards for visualizing model behavior to stakeholders.",
          },
        ],
      },
    ],
  });
}

function requirementsFixture() {
  return normalizeRequirements({
    role_summary: "Build and evaluate ML systems with a data-visualization front end.",
    requirements: [
      { text: "D3.js", kind: "must_have" },
      { text: "PyTorch", kind: "must_have" },
      { text: "model evaluation", kind: "responsibility" },
      { text: "stakeholder communication", kind: "competency" },
    ],
  });
}

/** Builds the persisted artifact the way the real pipeline does: through normalizePlan. */
function analysisFixture(rawCoverage?: { requirement: string; status: string; evidence: string }[]): JobEvidenceAnalysis {
  const profile = profileFixture();
  const requirements = requirementsFixture();
  const plan = normalizePlan(
    {
      roles: [{ company: "Bosch", title: "AI Engineer", level: "feature", rationale: "Directly relevant." }],
      coverage: rawCoverage ?? [
        // The model claiming the Plotly work proves D3.js is exactly the failure to catch.
        { requirement: "D3.js", status: "proven", evidence: "Created interactive Plotly dashboards for stakeholders" },
        { requirement: "PyTorch", status: "proven", evidence: "Built a personalization prototype using PyTorch" },
        { requirement: "model evaluation", status: "unproven", evidence: "" },
        {
          requirement: "stakeholder communication",
          status: "proven",
          evidence: "Created interactive Plotly dashboards for visualizing model behavior to stakeholders",
        },
      ],
      redundant_themes: [],
      notes: "",
    } as never,
    profile,
    requirements,
  );
  return { requirements, plan, profile_version: "abc123", analyzed_at: "2026-01-01T00:00:00.000Z" };
}

// ---------------------------------------------------------------------------
// Truthfulness -- adjacent experience must never become an exact claim
// ---------------------------------------------------------------------------

test("adjacent technology is not upgraded into exact claimed experience", () => {
  const analysis = analysisFixture();
  const d3 = analysis.plan.coverage.find((c) => c.requirement === "D3.js");

  // The model said "proven" and cited the Plotly dashboards -- real profile text, so the "did this
  // evidence come from the record?" check alone passes it. What must not pass is the claim itself:
  // "d3" appears nowhere in the record, so this cannot be confirmed experience. It is demoted to
  // partial, which is the honest reading -- there IS related visualization work, it just isn't D3.
  assert.notEqual(d3?.status, "proven", "adjacent experience must never be confirmed as the exact thing");
  assert.equal(d3?.status, "partial");
});

test("a requirement whose distinctive vocabulary is absent cannot be proven", () => {
  // Same shape, no visualization evidence to fall back on at all.
  const analysis = analysisFixture([
    { requirement: "D3.js", status: "proven", evidence: "Built a personalization prototype using PyTorch" },
    { requirement: "PyTorch", status: "unproven", evidence: "" },
    { requirement: "model evaluation", status: "unproven", evidence: "" },
    { requirement: "stakeholder communication", status: "unproven", evidence: "" },
  ]);
  assert.notEqual(analysis.plan.coverage.find((c) => c.requirement === "D3.js")?.status, "proven");
});

test("short but real skill tokens are not demoted by the vocabulary check", () => {
  // The regression this guards: a naive implementation drops words of 3 characters or fewer as
  // noise, which would quietly demote every genuine SQL/AWS/CAD/Go match -- exactly the tokens most
  // likely to be named as a hard requirement.
  const haystack = new Set(["sql", "aws", "postgres", "stakeholders", "deployment"]);
  assert.ok(requirementVocabularyPresent("SQL", haystack));
  assert.ok(requirementVocabularyPresent("AWS", haystack));
  assert.ok(requirementVocabularyPresent("stakeholder communication", haystack), "ordinary plurals must still match");
  assert.ok(requirementVocabularyPresent("experience with strong knowledge of SQL", haystack), "filler words are ignored");
  assert.ok(!requirementVocabularyPresent("Kubernetes", haystack));
  assert.ok(!requirementVocabularyPresent("D3.js", haystack));
  assert.ok(requirementVocabularyPresent("strong experience", haystack), "an all-filler requirement is not evidence of fabrication");
});

test("genuine evidence still survives the fabrication check", () => {
  const analysis = analysisFixture();
  // Same pass, same backstop -- PyTorch really is in the record, so it must not be collateral damage.
  assert.equal(analysis.plan.coverage.find((c) => c.requirement === "PyTorch")?.status, "proven");
  assert.equal(analysis.plan.coverage.find((c) => c.requirement === "stakeholder communication")?.status, "proven");
});

test("a requirement with no evidence at all stays unproven", () => {
  const analysis = analysisFixture();
  assert.equal(analysis.plan.coverage.find((c) => c.requirement === "model evaluation")?.status, "unproven");
});

test("the resume directive states unproven requirements as an explicit prohibition", () => {
  const directive = renderPlanDirective(analysisFixture().plan);
  assert.match(directive, /NOT SUPPORTED BY THE PROFILE/);
  assert.match(directive, /model evaluation/);

  // The demoted D3.js requirement must reach the writer in the "do not overstate" block, never as
  // something to visibly support.
  const partialBlock = directive.slice(
    directive.indexOf("PARTIALLY SUPPORTED"),
    directive.indexOf("NOT SUPPORTED BY THE PROFILE"),
  );
  const provenBlock = directive.slice(
    directive.indexOf("MUST BE VISIBLY SUPPORTED"),
    directive.indexOf("PARTIALLY SUPPORTED"),
  );
  assert.match(partialBlock, /D3\.js/);
  assert.doesNotMatch(provenBlock, /D3\.js/);
});

// ---------------------------------------------------------------------------
// Job analysis -- structured, not a blob
// ---------------------------------------------------------------------------

test("job analysis produces discrete, classified, stably-identified requirements", () => {
  const requirements = requirementsFixture();
  assert.equal(requirements.requirements.length, 4);
  assert.deepEqual(
    requirements.requirements.map((r) => r.id),
    ["r1", "r2", "r3", "r4"],
    "coverage and questions both reference requirements by id, so ids must be assigned in code",
  );
  assert.equal(requirements.requirements[0].kind, "must_have");
  assert.equal(requirements.requirements[3].kind, "competency");
});

test("requirement extraction drops duplicates and rejects invented kinds", () => {
  const requirements = normalizeRequirements({
    role_summary: "",
    requirements: [
      { text: "Python", kind: "must_have" },
      { text: "python", kind: "must_have" },
      { text: "Kubernetes", kind: "extremely_critical" },
      { text: "", kind: "must_have" },
    ],
  });
  assert.equal(requirements.requirements.length, 2, "case-insensitive duplicate and empty must both go");
  assert.equal(requirements.requirements[1].kind, "responsibility", "an unknown kind falls back, never passes through");
});

test("coverage counts summarize the graded plan for the readiness display", () => {
  const counts = coverageCounts(analysisFixture().plan);
  assert.deepEqual(counts, { proven: 2, partial: 1, unproven: 1 });
});

// ---------------------------------------------------------------------------
// Question generation
// ---------------------------------------------------------------------------

test("questions are dropped when they target a profile entity that does not exist", () => {
  const analysis = analysisFixture();
  const questions = normalizeStrengthenQuestions(
    [
      {
        requirement_id: "r3", entity_type: "work_experience", entity_id: "work_google_staff_2019",
        target_field: "outcomes", category: "outcome", priority: 90,
        question: "Tell me about evaluation at Google.", why_it_matters: "", answer_type: "long_text",
      },
      {
        requirement_id: "r3", entity_type: "work_experience", entity_id: "work_bosch_ai_engineer_2024",
        target_field: "outcomes", category: "outcome", priority: 80,
        question: "Did you define an evaluation process for the Bosch personalization work?",
        why_it_matters: "This role evaluates ML systems before deployment.", answer_type: "long_text",
      },
    ],
    profileFixture(),
    analysis,
  );

  assert.equal(questions.length, 1, "a question about a role the candidate never held must not be shown");
  assert.equal(questions[0].entity_id, "work_bosch_ai_engineer_2024");
});

test("questions carry the requirement they are chasing, so the page can group them", () => {
  const analysis = analysisFixture();
  const [question] = normalizeStrengthenQuestions(
    [{
      requirement_id: "r3", entity_type: "work_experience", entity_id: "work_bosch_ai_engineer_2024",
      target_field: "outcomes", category: "outcome", priority: 80,
      question: "How did you evaluate the personalization models?", why_it_matters: "", answer_type: "long_text",
    }],
    profileFixture(),
    analysis,
  );
  assert.equal(question.requirement_id, "r3");
  assert.equal(question.requirement_text, "model evaluation");
  assert.equal(question.entity_label, "Bosch — AI Engineer", "the label is resolved from the record, not the model");
});

test("a requirement the record already proves does not get a question unless a metric is missing", () => {
  const analysis = analysisFixture();
  const profile = profileFixture();
  const base = {
    entity_type: "work_experience", entity_id: "work_bosch_ai_engineer_2024",
    category: "other", priority: 50, why_it_matters: "", answer_type: "long_text",
  };

  // r2 (PyTorch) is proven. Asking about it again wastes the candidate's attention...
  const redundant = normalizeStrengthenQuestions(
    [{ ...base, requirement_id: "r2", target_field: "technologies", question: "Have you used PyTorch?" }],
    profile, analysis,
  );
  assert.equal(redundant.length, 0);

  // ...but a missing outcome on otherwise-strong evidence is the one carve-out worth asking about.
  const metric = normalizeStrengthenQuestions(
    [{ ...base, requirement_id: "r2", target_field: "metrics", question: "Did the PyTorch prototype produce a measurable result?" }],
    profile, analysis,
  );
  assert.equal(metric.length, 1);
});

test("questions are deduplicated, capped, and ordered by priority", () => {
  const analysis = analysisFixture();
  const duplicate = {
    requirement_id: "r3", entity_type: "work_experience", entity_id: "work_bosch_ai_engineer_2024",
    target_field: "outcomes", category: "outcome", why_it_matters: "", answer_type: "long_text",
  };
  const questions = normalizeStrengthenQuestions(
    [
      { ...duplicate, priority: 10, question: "First phrasing of the same question?" },
      { ...duplicate, priority: 95, question: "Second phrasing of the same question?" },
      {
        ...duplicate, target_field: "scope_and_scale", priority: 50,
        question: "How large was the dataset?",
      },
    ],
    profileFixture(),
    analysis,
  );

  assert.equal(questions.length, 2, "same entity + same field is the same question however it is worded");
  assert.equal(questions[0].priority, 50, "highest priority first");
  assert.equal(questions[0].target_field, "scope_and_scale");
});

test("a career-wide question is allowed to carry no entity id", () => {
  const questions = normalizeStrengthenQuestions(
    [{
      requirement_id: "", entity_type: "profile", entity_id: "", target_field: "career_signals",
      category: "other", priority: 30, question: "Have you led cross-functional work anywhere?",
      why_it_matters: "", answer_type: "long_text",
    }],
    profileFixture(),
    analysisFixture(),
  );
  assert.equal(questions.length, 1);
  assert.equal(questions[0].entity_id, "");
  assert.equal(questions[0].entity_label, "Career-wide");
});

test("malformed model output degrades to no questions rather than throwing", () => {
  assert.deepEqual(normalizeStrengthenQuestions(null, profileFixture(), analysisFixture()), []);
  assert.deepEqual(normalizeStrengthenQuestions("nope", profileFixture(), analysisFixture()), []);
  assert.deepEqual(normalizeStrengthenQuestions([{}, { question: "" }], profileFixture(), analysisFixture()), []);
});

// ---------------------------------------------------------------------------
// What the question generator is shown
// ---------------------------------------------------------------------------

test("the question generator sees proven requirements too, not only the gaps", () => {
  const rendered = renderCoverageForQuestions(analysisFixture());
  // Without the proven rows it would happily re-ask about PyTorch, which the record already shows.
  assert.match(rendered, /id=r2 \[must_have\] \[proven\] PyTorch/);
  assert.match(rendered, /id=r3 \[responsibility\] \[unproven\] model evaluation/);
  assert.match(rendered, /id=r1 \[must_have\] \[partial\] D3\.js/, "the demoted claim is shown as the partial match it is");
});

test("prior question state carries answers across jobs, which is what stops repeat questions", () => {
  const rendered = renderPriorQuestionState([
    {
      entity_label: "Bosch — AI Engineer", entity_type: "work_experience", target_field: "outcomes",
      category: "outcome", question: "How did you evaluate the models?", answer: "We ran an A/B test.",
      status: "applied",
    },
    {
      entity_label: "Bosch — AI Engineer", entity_type: "work_experience", target_field: "metrics",
      category: "metric", question: "Any numbers?", answer: "", status: "dismissed",
    },
  ]);
  assert.match(rendered, /\[applied\].*How did you evaluate the models\?.*answered: "We ran an A\/B test\."/s);
  assert.match(rendered, /\[dismissed\]/, "a declined question must be visible so it is never re-asked");
  assert.match(renderPriorQuestionState([]), /nothing has been asked/);
});

// ---------------------------------------------------------------------------
// Downstream handoff
// ---------------------------------------------------------------------------

test("cover letter receives the analysis with unproven requirements as a prohibition", () => {
  const rendered = renderCoverLetterEvidence(analysisFixture());
  assert.match(rendered, /WHAT THIS ROLE ACTUALLY IS: Build and evaluate ML systems/);
  assert.match(rendered, /STRONGEST GENUINE CONNECTIONS/);
  assert.match(rendered, /PyTorch/);
  assert.match(rendered, /NOT SUPPORTED BY THE RECORD/);

  // D3.js must never appear as a genuine connection the letter can build on.
  const connections = rendered.slice(
    rendered.indexOf("STRONGEST GENUINE CONNECTIONS"),
    rendered.indexOf("PARTIAL MATCHES"),
  );
  assert.doesNotMatch(connections, /D3\.js/);
  assert.match(rendered.slice(rendered.indexOf("PARTIAL MATCHES")), /D3\.js/);
});

test("cover letter evidence orders must-haves ahead of nice-to-haves", () => {
  const analysis = analysisFixture([
    { requirement: "D3.js", status: "unproven", evidence: "" },
    { requirement: "PyTorch", status: "proven", evidence: "Built a personalization prototype using PyTorch" },
    { requirement: "model evaluation", status: "unproven", evidence: "" },
    {
      requirement: "stakeholder communication", status: "proven",
      evidence: "Created interactive Plotly dashboards for visualizing model behavior to stakeholders",
    },
  ]);
  const rendered = renderCoverLetterEvidence(analysis);
  // PyTorch is a must_have and stakeholder communication is a competency, so PyTorch leads.
  assert.ok(
    rendered.indexOf("PyTorch") < rendered.indexOf("Plotly"),
    "the letter's best material should be the employer's most important requirement",
  );
});

test("partial matches are handed over with an explicit do-not-overstate instruction", () => {
  const analysis = analysisFixture([
    { requirement: "D3.js", status: "partial", evidence: "Created interactive Plotly dashboards for stakeholders" },
    { requirement: "PyTorch", status: "unproven", evidence: "" },
    { requirement: "model evaluation", status: "unproven", evidence: "" },
    { requirement: "stakeholder communication", status: "unproven", evidence: "" },
  ]);
  const rendered = renderCoverLetterEvidence(analysis);
  assert.match(rendered, /PARTIAL MATCHES/);
  assert.match(rendered, /describe the adjacent work by its real name/);
  assert.match(rendered, /asked for: D3\.js \| closest real experience: Created interactive Plotly/);
});

// ---------------------------------------------------------------------------
// Persistence and backward compatibility
// ---------------------------------------------------------------------------

test("a saved analysis round-trips through storage", () => {
  const analysis = analysisFixture();
  const restored = readJobEvidenceAnalysis(JSON.stringify(analysis));
  assert.ok(restored);
  assert.equal(restored.requirements.requirements.length, 4);
  assert.equal(restored.plan.coverage.length, 4);
  assert.equal(restored.profile_version, "abc123");
});

test("jobs that predate this feature read back as no analysis instead of crashing", () => {
  // Every one of these is a real state a pre-existing row can be in.
  assert.equal(readJobEvidenceAnalysis(null), null);
  assert.equal(readJobEvidenceAnalysis(undefined), null);
  assert.equal(readJobEvidenceAnalysis(""), null);
  assert.equal(readJobEvidenceAnalysis("{}"), null);
  assert.equal(readJobEvidenceAnalysis("not json at all"), null);
  assert.equal(readJobEvidenceAnalysis(JSON.stringify({ requirements: { requirements: [] } })), null);
});

// ---------------------------------------------------------------------------
// Prompt contracts
// ---------------------------------------------------------------------------

test("the strengthen-questions prompt falls back to the bundled default until Langfuse has one", async () => {
  const prompt = await getManagedPrompt(
    {} as never,
    "job/strengthen-questions",
    {
      job_title: "Applied AI Engineer", company: "Acme", role_summary: "Build ML systems.",
      requirement_coverage: "- id=r1 [must_have] [unproven] D3.js | evidence found: none",
      career_profile: "PROFILE", profile_entity_ids: "- work_experience | work_bosch | Bosch",
      prior_question_state: "(nothing)", resume_guidance: "GUIDANCE",
    },
    STRENGTHEN_QUESTIONS_PROMPT,
  );
  assert.match(prompt.name, /bundled default/);
  assert.match(prompt.text, /Applied AI Engineer/, "every declared variable must actually compile in");
  assert.match(prompt.text, /D3\.js/);
  assert.match(prompt.text, /GUIDANCE/);
  assert.doesNotMatch(prompt.text, /\{\{/, "an uncompiled placeholder would reach the model as literal text");
});

test("the strengthen prompt forbids turning adjacent experience into an exact claim", () => {
  assert.match(STRENGTHEN_QUESTIONS_PROMPT.text, /ADJACENT IS NOT THE SAME THING/);
  assert.match(STRENGTHEN_QUESTIONS_PROMPT.text, /D3\.js/);
});

test("the cover letter prompt's requires list can only be satisfied by an updated template", () => {
  // The staleness test is `.some()`: a live template counts as current if it mentions ANY listed
  // variable. So listing a variable the OLD prompt already had would make the live version pass
  // forever, this bundled text would never be served, and cover letters would quietly go back to
  // being written with no coverage report. Only genuinely new variables may appear here.
  assert.ok(COVER_LETTER_COMPOSE_PROMPT.requires.includes("job_analysis"));
  for (const preExisting of ["job_title", "company", "job_description", "review_answers", "contact_line", "candidate_profile"]) {
    assert.ok(
      !COVER_LETTER_COMPOSE_PROMPT.requires.includes(preExisting),
      `"${preExisting}" predates this change, so listing it would defeat the staleness check`,
    );
  }
});

test("the cover letter prompt compiles with every variable the call site sends", async () => {
  const prompt = await getManagedPrompt(
    {} as never,
    "cover_letter/compose",
    {
      job_title: "Applied AI Engineer", company: "Acme",
      job_description: "We need ML systems.", job_analysis: renderCoverLetterEvidence(analysisFixture()),
      review_answers: "", contact_line: "", candidate_profile: "PROFILE",
    },
    COVER_LETTER_COMPOSE_PROMPT,
  );
  assert.match(prompt.name, /bundled default/);
  assert.match(prompt.text, /Acme/);
  assert.match(prompt.text, /NOT SUPPORTED BY THE RECORD/, "the analysis has to actually reach the writer");
  assert.doesNotMatch(prompt.text, /\{\{/);
});
