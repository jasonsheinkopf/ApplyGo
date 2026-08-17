/**
 * Bundled canonical prompt texts, versioned against the application schema they expect.
 *
 * ApplyGo's rule is that substantive LLM instructions live in Langfuse Prompt Management, not in
 * the repository, so they can be revised without a deploy. That rule is unchanged: when Langfuse
 * holds a prompt whose template is compatible with the code calling it, Langfuse still wins.
 *
 * What this module adds is the missing safety property for a release that changes a prompt's
 * *contract*. Before this existed, shipping a new structured-output schema or a new variable set
 * meant the code and the production Langfuse prompt were briefly describing two different tasks --
 * and because a Langfuse template that simply never mentions a new variable compiles perfectly
 * happily (`compilePrompt` only fails the other way, on a variable the template wants and the code
 * doesn't send), that mismatch is *silent*. The model keeps being told to build the old thing while
 * the schema forces the shape of the new one, and the result is a technically valid, semantically
 * degraded profile that nothing alerts on.
 *
 * So each entry below declares `requires`: the variables a template must actually reference to be
 * considered current. `getManagedPrompt` treats a fetched prompt that references none of them as
 * stale and falls back to the text here. That makes a schema change safe to deploy before the
 * Langfuse prompt is updated, and makes the repo the readable record of what each prompt is
 * *supposed* to say. Once the matching version is promoted in Langfuse, these become dormant
 * again -- see README "Prompt Management".
 */

export type PromptDefault = {
  /** Variables that must appear in a Langfuse template for it to count as current. */
  requires: string[];
  /** The application schema generation this text is written against. */
  schemaVersion: number;
  text: string;
};

/**
 * Renamed from `profile/structure` to `profile/create` when schema v3 (stable entity ids, the
 * additional evidence dimensions, the `other[]` escape hatches) shipped -- the old name is no
 * longer registered in PROMPT_DEFAULTS, so a production Langfuse prompt still labeled
 * `profile/structure` will not be found and this bundled default will be used instead until a
 * `profile/create` prompt is promoted. See the top-of-file comment for why that fails safe rather
 * than silently running the old prompt against the new schema.
 */
export const PROFILE_CREATE_PROMPT: PromptDefault = {
  requires: ["current_profile", "source_material", "previous_entity_ids"],
  schemaVersion: 3,
  text: `You are building a comprehensive CAREER EVIDENCE RECORD for one person.

This is NOT a resume. Do not write it like one. A resume selects a small amount of evidence and
polishes it for one audience; this record collects everything the source material supports, in the
context where it happened, so that a later system can select from it. Length, ATS keywords,
presentation polish, and fitness for any particular job are explicitly NOT your concern here.

SOURCE MATERIAL (primary evidence -- resumes, CVs, documents, notes the candidate wrote, and answers
the candidate has given to previous Improve questions -- all first-person evidence):
{{source_material}}

CURRENT STRUCTURED PROFILE (a previous interpretation, which may be incomplete, weakly organized,
or produced against an older and much smaller schema):
{{current_profile}}

PREVIOUS ENTITY IDS (the "id" field of every work_experience/project/achievement/education/
independent_project/research entry in the current structured profile, one per line as
"id — label", so you can tell which real-world thing each previous id refers to):
{{previous_entity_ids}}

HOW TO USE THE INPUTS
The source material is primary evidence. The current profile is a previous interpretation of that
same evidence -- useful for continuity and as secondary evidence for facts whose original document
is no longer present, but it is not authoritative and it is not a baseline to append to.

Reconsider the whole record every time. Do NOT simply copy the current profile forward and add new
items to it. Rebuild it from the source material, using the current profile to avoid losing facts
the sources no longer mention.

Specifically:
- Use ALL available source material, not just the most recent document.
- Recover detail that earlier passes missed. Older schemas had nowhere to put project work,
  mentoring, stakeholder contact, or metrics, so that information was routinely dropped. Look for it.
- Re-categorize when the evidence supports it. A previous pass's mistake is not permanent.
- Deduplicate. The same real-world job described in three different resumes is ONE work_experience
  entry, merged, not three. Combine complementary detail from every document that describes it.
- Merge, don't truncate. If one resume describes a role in one line and another describes it in ten,
  the merged entry keeps the detail from both.
- Evidence that came from an Improve answer is first-person and just as authoritative as a document
  the candidate uploaded -- integrate it the same way, attributed to the role/project it is about.

STABLE ENTITY IDS
Every work_experience entry, project (inside a role, independently, or under education), achievement,
education entry, independent_project, and research_and_publications entry needs an "id" field.
- If PREVIOUS ENTITY IDS above contains an id for what is clearly the same real-world role, project,
  achievement, degree, or publication, reuse that EXACT id string. Do not rename it, even if you are
  now describing it more completely or correctly than before.
- Only mint a new id when there is no reasonable match in the previous list -- a genuinely new role,
  project, etc. A new id is lowercase, ascii, underscore-separated, and readable: organization +
  title + year for a role ("work_bosch_ai_engineer_2024"), project name for a project
  ("project_vehicle_personalization"), institution + degree + year for education
  ("education_georgia_tech_ms_cs_2019"). If you cannot form a good one, leave "id" empty and the
  system will assign one.
- Never invent a match. If it's genuinely ambiguous whether an entry is the same real-world thing as
  a previous one, prefer minting a new id over guessing wrong -- a wrongly reused id points a future
  question at the wrong role.

RULES
- Never invent a fact. If the sources do not support it, it does not go in.
- Leave unknown scalars as empty strings and unknown lists as empty arrays. Do not write
  placeholders, "N/A", or guesses, and never create an entry just to make a section non-empty.
- Copy metrics EXACTLY as stated. Never estimate, round, convert, or infer a number.
- Preserve context. Work belongs inside the role, degree, or project where it happened -- mentoring
  done at a company goes in that company's entry, an award for a university project goes on that
  project. Do not lift things into flat global lists that lose their origin.
- Distinguish responsibilities (ongoing duties -- what they were accountable for) from achievements
  (discrete accomplishments -- what they actually delivered). These are different fields.
- Actively look for quantitative evidence when it exists (revenue, time/cost saved, throughput,
  accuracy, adoption, users served, team/stakeholder counts, geographic scope, duration, portfolio
  size, hires, frequency, percentage change, deadlines met, risk avoided, incidents prevented,
  systems shipped, decisions enabled, demonstrations, publications, awards, promotions, customer
  acceptance, deployment) -- but a strong qualitative outcome with no number attached is still
  valuable evidence and belongs in the record exactly as stated.
- Use collaborators_and_stakeholders, scope_and_scale, constraints_and_challenges, decisions_enabled
  and recognition wherever the source material actually supports them -- they exist because this
  kind of detail is exactly what earlier, resume-shaped schemas lost.
- Use each entity's "other" array for factual detail that is real but doesn't fit a named field.
  Never use "other" to dodge a more specific field that actually fits.
- For rollup sections (technical_skills, tools_and_technologies, professional_skills,
  domain_knowledge, career_signals), cite evidence. A skill that appears nowhere in the record's
  actual history does not belong in the rollup.
- career_signals are durable observed patterns across the whole record, e.g. "repeatedly bridges
  technical and non-technical audiences". They are observations, not career advice. Do not
  recommend roles, industries, or next steps anywhere in this output.
- evidence_gaps names what is missing or ambiguous and would change the picture if known. Name the
  gap and suggest a question. Never fill the gap in with a guess. (This is a lightweight, best-effort
  list; the Improve workflow's dedicated audit is the thorough version of this same idea and runs
  separately.)

Return only the structured output.`,
};

/** @deprecated Kept only as an alias so any code or test still importing the pre-v3 name keeps
 * working. New code should use PROFILE_CREATE_PROMPT and the "profile/create" registry key. */
export const PROFILE_STRUCTURE_PROMPT = PROFILE_CREATE_PROMPT;

export const ROLES_ANALYZE_PROMPT: PromptDefault = {
  requires: ["good_examples", "bad_examples", "candidate_background"],
  schemaVersion: 2,
  text: `You are identifying which genuinely distinct role families this candidate should search for.

CANDIDATE BACKGROUND -- CAPABILITY EVIDENCE
This is the full career evidence record. It is the ONLY thing that establishes what this person can
actually do.
{{candidate_background}}

{{notes_and_links}}

{{good_examples}}

{{bad_examples}}

{{locations}}

{{dealbreakers}}

{{criteria}}

HOW TO WEIGH THESE INPUTS
- Candidate background is capability evidence. It answers "what can this person plausibly do?"
- Preferences, notes and links express DIRECTION -- what sounds appealing. They are not proof of
  qualification. A stated interest with no supporting evidence in the background is not a role
  recommendation. If someone writes "I want to be a neurosurgeon" and the record contains no
  medical training, that role does not appear.
- Good and bad examples are SEMANTIC examples of what the candidate means, not keyword filters.
  Infer the shared characteristics across them -- the kind of work, the balance of responsibilities,
  the amount of customer contact, the seniority, the company context -- and treat recurring
  characteristics in the good examples as desirable and in the bad examples as undesirable, even for
  characteristics the candidate never stated in words.
- Location, deal breakers and priorities are search constraints and context, not role definitions.

Your recommendations are the INTERSECTION of capability and preference.

DISCOVERY IS THE POINT
Do not merely echo titles the candidate already named. A large part of the value here is surfacing
real career paths they may not know the name of. Someone with teaching, engineering and
stakeholder-facing experience may genuinely support several different established role families even
if they had only ever heard of one of them. Look for those.

ROLE FAMILIES MUST BE REAL
- Every title must be a recognizable job-market category that employers actually post. Use titles a
  candidate could type into a job board and get results for.
- alternate_titles are other real titles employers use for substantially the same job.
- NEVER invent hybrid careers by blending distinct paths into one title. "Machine Learning Advocate
  Trainer" is not a job. If the evidence supports Applied AI Engineer AND Developer Advocate AND
  Technical Trainer, return THREE separate entries.
- Keep genuinely different career families separate even when one person could plausibly do all of
  them. A posting only has to match ONE family strongly to be worth surfacing, so separate entries
  cost nothing and merged entries match nothing.
- Typically 3-8 families. Prefer fewer, well-evidenced families over many speculative ones.

FOR EACH ROLE
- fit_summary: one or two sentences on why this path makes sense for this specific person.
- why_this_fits: each claim paired with concrete evidence drawn from the candidate background. Cite
  what they actually did. Do not assert fit without pointing at the evidence for it.
- search_title_terms: the literal title words to match against job postings. These are used by a
  cheap deterministic title filter, so keep them short, common, and recall-oriented -- the terms an
  employer would put in a posting title, not a description of the work.
- search_keywords: body keywords that indicate this kind of role.
- possible_gaps_or_cautions: honest weaknesses for this path, and what would strengthen it. Do not
  flatter.

SUMMARY FIELD
The summary covers only what is true regardless of which role is being considered -- location
constraints, hard limits, what to avoid, what matters generally. Never name a job title in it.

Return only the structured output.`,
};

export const ROLES_RESEARCH_PROMPT: PromptDefault = {
  requires: ["role_title", "source_documents"],
  schemaVersion: 2,
  text: `You are interpreting labor-market source documents for one role, in one location.

ROLE: {{role_title}}
ALTERNATE TITLES: {{alternate_titles}}
SENIORITY: {{seniority}}
LOCATION CONTEXT: {{locations}}

SOURCE DOCUMENTS (retrieved from external sources just now -- this is the ONLY factual basis you
may use):
{{source_documents}}

ABSOLUTE RULE
Report only what these documents actually state. You have no reliable current knowledge of salaries
or employment outlook from memory, and inventing a plausible-sounding number here would be worse
than reporting nothing -- the candidate would have no way to tell the difference.

- If the documents do not support a figure, leave it empty. Do not estimate, interpolate between
  other numbers, or convert an unrelated statistic into the one asked for.
- Attribute every figure to the source it came from, by name.
- If the documents are about a different role or a different geography than the one asked for, say
  so in the caveats rather than reporting the number as if it applied.
- demand_direction must be one of: growing, stable, declining, unclear. Use "unclear" freely; it is
  the honest answer when the documents disagree or do not address it.
- Prefer official government labor statistics over aggregators when both are present and they
  disagree, and say in the caveats that they disagreed.

Return only the structured output.`,
};

/**
 * The Improve workflow's first half: look at the career evidence record (plus what has already
 * been asked, answered, and dismissed) and propose the highest-value next questions. This is
 * explicitly an audit, not a chat -- it never writes to the profile itself.
 */
export const PROFILE_IMPROVE_AUDIT_PROMPT: PromptDefault = {
  requires: ["career_profile", "prior_question_state"],
  schemaVersion: 3,
  text: `You are auditing one person's CAREER EVIDENCE RECORD to find the highest-value missing
evidence, then writing targeted questions to ask them for it.

You are not writing a resume and not giving career advice. Your only job is: find real, specific
gaps in what this record can currently prove, and ask about them.

CAREER EVIDENCE RECORD:
{{career_profile}}

PRIOR QUESTION STATE (questions already asked in earlier audits, with their current status --
pending, answered, applied, dismissed, or obsolete):
{{prior_question_state}}

DO NOT RE-ASK RESOLVED QUESTIONS
Never regenerate a question that prior question state shows as answered, applied, or dismissed for
the same entity and target_field -- that ground has already been covered or the candidate has
already said they don't have or don't want to give that information. A genuinely still-ambiguous
answered question may justify ONE sharper, more specific follow-up, not a repeat of the same
question. A "pending" question from a prior audit that is still valuable can be repeated verbatim
rather than duplicated with slightly different wording.

WHAT TO LOOK FOR
For every meaningful role, project, research item, or leadership/mentoring activity actually present
in the record, look for gaps across these dimensions -- but infer from the record which of them
actually apply to this person's career; do not force every dimension onto every entity, and do not
treat this as an engineering-only checklist:

(A) Accountability / ownership -- was this person driving it, contributing to it, or something in
    between? The record often leaves this ambiguous.
(B) Concrete work performed -- ask about a SPECIFIC activity already named in the record (built,
    designed, implemented, launched, migrated, automated, researched, analyzed, taught, negotiated,
    coordinated, hired, mentored, presented, deployed, debugged, validated, and equivalents outside
    engineering), never "tell me more about your job".
(C) Why the work existed -- problem, business need, user need, technical constraint, research
    question, customer request, organizational objective.
(D) What happened because of the work -- shipped, decision enabled, roadmap changed, approved or
    stopped, cost/time saved, quality/performance improved, revenue, adoption, customer/student/
    research result, publication, award, deployment, demonstration, stakeholder acceptance, repeat
    use, process improvement, risk reduction. Never assume the result; ask.
(E) Scope and scale -- team size, collaborators, teams, regions, customers, users, students,
    employees, hires, projects, models, datasets, locations, partners, budget, revenue, duration,
    frequency, volume, systems, events, courses. Only ask when plausible from context; never imply
    the answer must be large.
(F) Collaboration -- who else was involved: engineering, product, design, sales, legal, ops,
    executives, clients, vendors, researchers, teachers, architects, external partners, subject
    matter experts, international teams.
(G) Tools/technologies IN CONTEXT, not as a flat keyword list -- ask what specific tool, system,
    language, or framework was used for a described piece of work. Skip entirely when technology is
    irrelevant to the work (this must work for non-engineering careers too).
(H) Leadership -- without inflating it to "management" unless the record supports that: ownership,
    coordinating peers, mentoring, hiring, onboarding, reviewing others' work, setting direction,
    standards or process, persuading stakeholders.
(I) Communication/stakeholder evidence -- presentations, demos, reports, docs, customer meetings,
    executive communication, workshops, curriculum, training, proposals, requirements gathering.
(J) Constraints that make an accomplishment more meaningful -- no or poor data, small dataset,
    limited budget, short deadline, safety/regulatory requirements, legacy systems, ambiguous
    requirements, distributed or cross-language teams, hardware limits, customer-specific
    requirements.
(K) Distinctive evidence already present that could use more detail -- awards, publications,
    patents, open source, speaking, cross-domain experience, promotions, selection for special work,
    high-trust responsibilities, mentoring, zero-to-one ownership, cross-discipline projects. Ask
    about plausible missing DETAIL around distinction that already exists; never ask the candidate
    to manufacture distinction that isn't there.

CROSS-CAREER CALIBRATION EXAMPLES (anchors, not an exhaustive list -- infer the right dimensions for
whatever careers actually appear in this record):
- Logistics/operations: order or shipment volume, on-time delivery rate, inventory accuracy,
  vendors/carriers managed, cost, delays, compliance, number of locations.
- Sales: quota, pipeline, revenue, conversion rate, deal size, number of accounts, renewal rate,
  territory, CRM used.
- Education/teaching: number of students, courses taught, curriculum designed, assessment/outcome
  improvement, programs created, teachers coordinated, stakeholders involved, learning outcomes.

QUESTION QUALITY RULES
- Specific, not generic: "How was the improvement to the vehicle-personalization prototype
  measured -- a before/after score, a percentage change, a count of something, or something else?"
  is good. "Tell me more about your job at Bosch" is not a question, it's a prompt for a monologue.
- Grounded: every question must arise from something that already exists in the record above. Never
  ask about a project, role, or claim the record does not actually contain.
- Non-redundant: the record is given to you in full specifically so you can check whether the
  information is already present somewhere else before asking for it again.
- Non-leading about facts: it is fine to offer example answer shapes ("...a decision, deployment,
  cost reduction, time savings, or another concrete outcome? If so, what happened?"). It is NOT fine
  to assume a specific event occurred ("How much money did this save?" assumes savings occurred --
  don't ask that; ask whether it did, and if so what, and how it was measured).
- Never ask a bare "what percentage did this improve?" with no context. Give the candidate a
  plausible menu of ways they might know the answer, in their own domain's terms.

TARGETING
Every question must reference the entity it is about using entity_type and entity_id copied EXACTLY
from the ids shown in the career evidence record (e.g. an id like "work_bosch_ai_engineer_2024" or
"project_vehicle_personalization"). Use entity_type "profile" with an empty entity_id only for a
question that is genuinely about the person as a whole (identity, career-wide pattern) and cannot be
attached to one entity. Never invent an entity_id that does not appear in the record.

PRIORITY (0-100)
High priority: missing outcome for a major or recent project, missing scope for a leadership claim,
unclear ownership, missing quantitative evidence where a metric plausibly exists, ambiguity that
affects credibility, missing context around a distinctive accomplishment, unclear result of an
important initiative.
Lower priority: minor historical detail, redundant evidence, low-relevance hobby detail, information
unlikely to matter later.

VOLUME
Generate as many genuinely useful questions as the record warrants, but do not pad to hit a number.
Cap at roughly 30 unresolved questions per pass, sorted highest-value first -- if more real gaps
exist than that, surface the best ones now; a later pass will find the rest.

If the record already has strong detail across everything you checked and no genuinely valuable gap
remains, return an empty questions array. Do not manufacture filler questions to avoid an empty
result.

Return only the structured output.`,
};

/**
 * The Improve workflow's second half: take the candidate's saved answers and integrate them into
 * the canonical structured profile. This never runs on its own trigger -- only after the candidate
 * has saved at least one answer and pressed "Apply Answers & Continue".
 */
export const PROFILE_IMPROVE_APPLY_PROMPT: PromptDefault = {
  requires: ["career_profile", "answered_questions"],
  schemaVersion: 3,
  text: `You are integrating newly answered interview questions into one person's CAREER EVIDENCE
RECORD, without inventing anything the answers do not support.

CURRENT CAREER EVIDENCE RECORD (the complete canonical record; return an updated version of this
exact same shape):
{{career_profile}}

NEWLY ANSWERED QUESTIONS (each with the entity it targets, the field it was aimed at, the question
asked, why it mattered, and the candidate's own answer in their own words):
{{answered_questions}}

YOUR JOB
1. Read each answer and understand what it actually says -- including cases where a chatty or
   informal answer contains several distinct facts. Example: "Yeah, there were probably 4 teams,
   Japan, Germany, China and US, and I basically had to get everybody aligned before we could run
   the test" supports THREE separate additions: a list of collaborators/regions in
   collaborators_and_stakeholders, a team/region count in scope_and_scale, and the coordination
   outcome in outcomes (or decisions_enabled if the alignment led to a decision) -- distribute the
   answer across whichever fields it actually supports. Never invent a fact or number the answer
   does not state, even one that would be a natural continuation of what they said.
2. Locate the entity the question's entity_type/entity_id points at in the current record and add
   the supported information to the right field(s) on that entity. If entity_type is "profile" with
   no entity_id, the update is career-wide (identity, career_summary, career_signals).
3. When an answer explicitly corrects something the record currently says (a wrong date, a
   misattributed outcome, a role the candidate says was actually different), correct it. Only do
   this when the correction is explicit and clear from the answer -- do not reinterpret an answer as
   a correction unless the candidate is plainly saying the previous version was wrong.
4. Deduplicate: if the answer restates something already in the record, do not add a near-duplicate
   entry.
5. Preserve everything unrelated to these answers exactly as it already is. This is an update, not a
   regeneration -- entities, ids, and evidence the answers did not touch must come back unchanged.
6. Never invent a fact, metric, outcome, technology, collaborator, or scope figure the answer does
   not state. An answer that says "I don't remember" or is otherwise non-committal supports adding
   nothing; leave the field as it was.
7. Return the complete, valid, updated career evidence record in the same schema as the input --
   every entity keeps its existing "id"; do not renumber or regenerate ids.

Return only the structured output.`,
};

/**

/**
 * The cover-letter writer, now given the same structured job analysis the resume gets.
 *
 * This entry is new, and adding it deliberately supersedes whatever `cover_letter/compose` version
 * is currently live in Langfuse: `requires` names `job_analysis`, which no existing template
 * mentions, so `getManagedPrompt` treats the live one as stale and serves this text until a
 * matching version is promoted. That is the mechanism this module exists for (see the top-of-file
 * comment) and it is the right trade here -- a letter written without the coverage report can
 * cheerfully claim a requirement the candidate cannot prove, which is the exact failure the
 * analysis was built to prevent. Everything the previous template received is still passed, so the
 * only behavioral difference is the added grounding.
 */
export const COVER_LETTER_COMPOSE_PROMPT: PromptDefault = {
  // ONLY the genuinely new variable, and that is load-bearing rather than lazy. `requires` is
  // tested with `.some()` (see isPromptCompatible), so a live template counts as current if it
  // mentions ANY listed variable. Listing a pre-existing one like `candidate_profile` -- which
  // every previous version of this prompt already references -- would make the live prompt pass the
  // staleness test forever, this bundled text would never be served, and cover letters would go on
  // being written with no coverage report at all. The whole point is that only a template updated
  // for the new contract can satisfy this.
  requires: ["job_analysis"],
  schemaVersion: 3,
  text: `You are writing one cover letter for one specific job application.

THE JOB: {{job_title}} at {{company}}

JOB DESCRIPTION:
{{job_description}}

{{job_analysis}}

{{review_answers}}{{contact_line}}
THE CANDIDATE'S CAREER EVIDENCE RECORD:
{{candidate_profile}}

WHAT THIS LETTER IS FOR
A cover letter is not a prose version of the resume. The reader already has the resume. This letter
earns its place only by doing something the resume cannot: connecting a small number of specific
things this candidate has actually done to what this specific employer says they need, and saying
why that connection is real.

So: pick the two or three strongest genuine connections and develop them. Do not inventory the
candidate's history, do not walk through the requirement list, and do not restate bullets.

GROUNDING -- THIS IS THE HARD CONSTRAINT
The job analysis above has already been verified against the candidate's record in code. Treat it
as authoritative:
- Things listed as strongest genuine connections are safe to build the letter on.
- Things listed as partial matches must be described as what they actually are. Name the real
  technology or the real scope. Never let adjacent experience read as the exact thing asked for.
- Things listed as not supported must not appear at all -- not as a claim, not as an implication,
  not as enthusiasm phrased to sound like experience ("excited to bring my Kubernetes experience"
  when there is none). Silence about a gap is correct and expected.

Never invent a metric, a responsibility, a scale figure, a technology, an outcome, a title, a date,
a customer, a deployment, or a credential. If a detail is not in the record above, it does not exist
for the purposes of this letter.

VOICE AND FORM
- Address the specific company and role. Never write a placeholder like [Company Name].
- Open with something substantive. No "I am writing to apply for the position of...".
- Plain, direct, professional. No breathless enthusiasm, no self-assessment adjectives
  ("passionate", "hard-working", "detail-oriented"), no cliches about being a perfect fit.
- Concrete over abstract: what was built, what problem it solved, what happened as a result.
- Roughly 3 short paragraphs, under 300 words, unless instructions above say otherwise. A tight
  letter that a busy reader finishes beats a thorough one they abandon.
- Plain paragraphs separated by blank lines. No markdown, no bullet points, no headers.
- End with a simple sign-off.

Return only the structured output.`,
};

/**
 * Strengthen Profile's one new model call: graded requirement coverage in, targeted questions out.
 *
 * The whole reason this is a separate prompt from `profile/improve-audit` rather than a variant of
 * it: the generic audit has to guess which of a candidate's gaps matter, so it spreads thin across
 * every dimension of every entity. This one is told exactly what a specific employer asked for and
 * exactly which of those things the record can and cannot currently prove, so it can spend all of
 * its attention on the handful of questions whose answers would actually change this application.
 */
export const STRENGTHEN_QUESTIONS_PROMPT: PromptDefault = {
  requires: ["requirement_coverage", "career_profile", "prior_question_state"],
  schemaVersion: 3,
  text: `You are helping one candidate remember evidence they already have but have not yet written
down, using a specific job they want as the prompt.

You are NOT writing a resume, NOT giving career advice, and NOT helping them acquire qualifications
they lack. Your only job: find the places where this posting asks for something the candidate's
record cannot currently prove, and ask a question that could plausibly uncover real evidence they
genuinely have.

THE JOB: {{job_title}} at {{company}}
WHAT THE ROLE IS: {{role_summary}}

REQUIREMENT COVERAGE (already computed -- each requirement, how important it is, whether the record
currently proves it, and the best supporting evidence found):
{{requirement_coverage}}

THE CANDIDATE'S CAREER EVIDENCE RECORD:
{{career_profile}}

PROFILE ENTITY IDS you may target (entity_type | entity_id | label). Copy an id EXACTLY; never
invent one:
{{profile_entity_ids}}

ALREADY ASKED BEFORE (across every job and every earlier pass, with status):
{{prior_question_state}}

WHAT MAKES EVIDENCE STRONG (use this to judge whether existing evidence is actually good enough,
and to decide what a question should ask for):
{{resume_guidance}}

WHERE TO SPEND QUESTIONS
- [unproven] requirements are the priority IF it is plausible this candidate has relevant
  experience they simply have not recorded. Their record is in front of you -- use it to judge.
- [partial] requirements are often the most valuable of all: the candidate has adjacent experience,
  and the question is whether the real thing is hiding behind a thin description.
- [proven] requirements are usually finished. Ask about one ONLY when a genuinely valuable metric,
  outcome, or scale figure is missing from otherwise strong evidence.
- Weight by importance: a must_have the record cannot prove matters far more than a nice-to-have.

DO NOT ASK
- Anything the prior question state shows as answered, applied, or dismissed for the same entity
  and the same kind of detail. That ground is covered, or the candidate has already declined it.
  This matters more than anything else here: this candidate will do this for many jobs, and the
  number of questions is supposed to fall as their record fills in. Re-asking makes it useless.
- Anything the career record already answers somewhere else. The full record is given to you
  precisely so you can check before asking.
- Anything about a requirement where it is implausible this candidate has hidden experience. If the
  posting wants 10 years of embedded firmware and the record is entirely teaching and web work,
  there is nothing to uncover. Leave the gap alone -- an honest gap is a valid outcome.
- Questions that ask the candidate to acquire, estimate, or manufacture something. You are looking
  for what already happened.

HOW TO WRITE THE QUESTION
Ground every question in something the record already contains, and name it. The candidate should
be able to tell instantly which piece of their own history you are asking about.

  Bad:  "Do you have experience with model evaluation?"
  Good: "This role emphasizes evaluating ML systems before deployment. In your vehicle
         personalization work at Bosch, did you define or run any process for comparing models,
         validating personalization quality, or deciding whether an approach was good enough to
         continue? If so, what did you measure and what did you decide?"

- Offer a menu of plausible answer shapes rather than assuming which one is true. "Was there a
  measurable result -- a before/after number, a count, a time saved, or a decision that changed?"
  is fair. "How much money did this save?" is not: it presumes savings happened.
- Accept "no" as a real answer. Phrase questions so that "I didn't do that" is a natural response
  and not a failure. A truthful gap is better than a stretched claim.
- One question should ask for one thing. If a role needs three separate details, that is up to
  three questions, each targeted at its own field.
- A question may be leading about WHERE to look ("your profile says you led part of the PoC --
  did that include coordinating requirements with stakeholders?"). It may never be leading about
  WHAT THE ANSWER IS.

ADJACENT IS NOT THE SAME THING
If the posting asks for D3.js and the record shows Plotly, you may ask whether they have also used
D3.js, or what the visualization work actually involved. You may NOT phrase the question so that
answering it implies D3.js experience, and you may not treat the Plotly work as though it were
D3.js. The same holds for every technology, seniority level, scale figure, and outcome.

VOLUME
Return at most 12 questions, best first. Returning 4 excellent questions is a better outcome than
12 padded ones. If the record already covers everything this posting reasonably probes, return an
empty questions array -- that is a success, not a failure.

Return only the structured output.`,
};

/**
 * Tier-1 job screening: a cheap yes/no pass over a batch of postings' titles and locations only
 * (no description), run for every single new posting before anything more expensive touches it.
 * That makes it the highest-volume LLM call in the app by a wide margin, which is exactly why it
 * needs a bundled fallback -- a Langfuse hiccup here does not just degrade one feature, it stalls
 * the entire "Find Jobs" pipeline (see fit.ts's screenJobsBatch, which is the only caller).
 */
export const JOBS_PRESCREEN_PROMPT: PromptDefault = {
  requires: ["candidate_profile", "postings"],
  schemaVersion: 1,
  text: `You are the first, cheap pass over a batch of job postings, judging ONLY each posting's
title and location -- you deliberately do not have the description. Your only job is to catch a
posting that is obviously a different profession or field entirely, so it doesn't waste a full,
expensive read later.

{{target_roles}}{{disqualifiers}}
CANDIDATE PROFILE (for field/profession context only -- do not judge seniority, specific skills, or
detailed fit here; you don't have enough information to and shouldn't try):
{{candidate_profile}}

POSTINGS (id, title, location):
{{postings}}

RULES
- Judge only whether the TITLE plausibly belongs to the same profession/field as the candidate --
  e.g. a "Propulsion Engineer" posting is not a software fit no matter what its full description
  might say, but you cannot see that description here, so never guess at it.
- When genuinely unsure, keep the posting. A wrong "drop" here is invisible to the candidate and
  permanently loses a posting a full read might have kept; a wrong "keep" only costs one more cheap
  read later.
- note is a short (under 15 word) reason, filled in ONLY when keep is false. Leave it empty when
  keep is true.

Return exactly one result per posting id in the input, with that same id, a keep boolean, and note.

Return only the structured output.`,
};

/** Registry consulted by getManagedPrompt. Prompts absent here behave exactly as before. */
export const PROMPT_DEFAULTS: Record<string, PromptDefault> = {
  "profile/create": PROFILE_CREATE_PROMPT,
  "profile/improve-audit": PROFILE_IMPROVE_AUDIT_PROMPT,
  "profile/improve-apply": PROFILE_IMPROVE_APPLY_PROMPT,
  "job/strengthen-questions": STRENGTHEN_QUESTIONS_PROMPT,
  "cover_letter/compose": COVER_LETTER_COMPOSE_PROMPT,
  "roles/analyze": ROLES_ANALYZE_PROMPT,
  "roles/research": ROLES_RESEARCH_PROMPT,
  "jobs/prescreen": JOBS_PRESCREEN_PROMPT,
};
