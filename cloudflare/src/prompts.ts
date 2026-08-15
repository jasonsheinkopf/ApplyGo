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

export const PROFILE_STRUCTURE_PROMPT: PromptDefault = {
  requires: ["current_profile", "source_material"],
  schemaVersion: 2,
  text: `You are building a comprehensive CAREER EVIDENCE RECORD for one person.

This is NOT a resume. Do not write it like one. A resume selects a small amount of evidence and
polishes it for one audience; this record collects everything the source material supports, in the
context where it happened, so that a later system can select from it. Length, ATS keywords,
presentation polish, and fitness for any particular job are explicitly NOT your concern here.

SOURCE MATERIAL (primary evidence -- resumes, CVs, documents, and notes the candidate wrote):
{{source_material}}

CURRENT STRUCTURED PROFILE (a previous interpretation, which may be incomplete, weakly organized,
or produced against an older and much smaller schema):
{{current_profile}}

HOW TO USE THE TWO INPUTS
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
- For rollup sections (technical_skills, tools_and_technologies, professional_skills,
  domain_knowledge, career_signals), cite evidence. A skill that appears nowhere in the record's
  actual history does not belong in the rollup.
- career_signals are durable observed patterns across the whole record, e.g. "repeatedly bridges
  technical and non-technical audiences". They are observations, not career advice. Do not
  recommend roles, industries, or next steps anywhere in this output.
- evidence_gaps names what is missing or ambiguous and would change the picture if known. Name the
  gap and suggest a question. Never fill the gap in with a guess.

Return only the structured output.`,
};

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

/** Registry consulted by getManagedPrompt. Prompts absent here behave exactly as before. */
export const PROMPT_DEFAULTS: Record<string, PromptDefault> = {
  "profile/structure": PROFILE_STRUCTURE_PROMPT,
  "roles/analyze": ROLES_ANALYZE_PROMPT,
  "roles/research": ROLES_RESEARCH_PROMPT,
};
