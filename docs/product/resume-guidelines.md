# Resume Guidelines

This is ApplyGo's single answer to two questions:

- **How does ApplyGo decide what information belongs on a job-specific resume?**
- **How does ApplyGo progressively improve the candidate profile?**

Before this document existed the answers were spread across a compose prompt, a planning module, and
a general sense of good practice. That is exactly how an application ends up with two competing
resume philosophies — a keyword-matching one and an evidence-based one — that quietly disagree.

## Where the canonical text actually lives

The authoritative version of these rules is **`RESUME_GUIDANCE` in
[`cloudflare/src/philosophy.ts`](../../cloudflare/src/philosophy.ts)**, as a string constant.

This page explains and justifies it; it does not restate it. If the two ever disagree, the constant
wins and this page is out of date.

It lives in code because it has two consumers that must not drift apart:

1. **The resume writer**, which must follow it. It is prepended to every `resume/compose` call
   through the `plan_directive` variable.
2. **The Strengthen Profile question generator**, which must know what *makes* evidence
   resume-grade — that is precisely how it can tell that "Used PyTorch for machine learning" is a
   weak claim worth asking about, and ask what was built, what it was evaluated against, and what
   changed as a result.

A rule that only the writer knows would produce a resume the profile cannot support. A rule that
only the interviewer knows would collect evidence the resume never uses. One shared constant makes
that class of drift impossible.

## The philosophy in one line

> Exact terminology + natural, verifiable evidence + technical context + impact.

Every clause is doing work:

- **Exact terminology** — use the posting's own words *when they truthfully describe what the
  candidate did*. That is how both a human reader and a keyword search recognize a real match.
- **Natural, verifiable evidence** — every substantive claim traces back to something in the
  candidate's record. Enforced in code, not just asked for in a prompt (see below).
- **Technical context** — a technology named without the problem it solved is a parts list. What
  the system did, what constrained the choice, and what it achieved is the actual signal.
- **Impact** — what resulted. Quantified when a genuine number exists, qualitative when it does not,
  and never invented in either case.

This explicitly **rejects keyword stuffing**. Restating a requirement as though it were experience
is the failure this whole design is built to prevent, not a shortcut it tolerates.

## What we are (and are not) optimizing for

There is no universal "ATS score" to game, and ApplyGo does not pretend otherwise. A modern
recruiting pipeline can include any of: résumé parsing, knockout questions, structured filters,
full-text and exact keyword search, semantic matching, AI-assisted criteria evaluation, ranking, and
human review. These reward different things and no single trick satisfies all of them.

The one strategy that serves every stage — and the human at the end of it — is the same: accurate,
specific, well-organized evidence written in the vocabulary the field actually uses. So ApplyGo
optimizes for *representing the candidate accurately in terms both machines and people understand*,
and treats "beat the ATS" as a category error.

## Sources

The guidance is synthesized from two bodies of material that turned out to agree more than they
disagree.

**The [r/EngineeringResumes wiki](https://www.reddit.com/r/EngineeringResumes/wiki/index/)**
(read from the community's own [GitHub
mirror](https://github.com/r-engineeringresumes/subreddit-wiki)) supplies the bullet-level craft:

- STAR / CAR / XYZ as *reasoning frames for finding the missing half of a weak bullet*, explicitly
  not as templates — the wiki's own framing is that they are a cure for writer's block, and bullets
  that all visibly follow one formula read as generated.
- Strong past-tense action verbs, and a specific blocklist of weak ones (`assisted`, `helped`,
  `worked on`, `used`, `utilized`) and inflated ones (`spearheaded`, `orchestrated`, `pioneered`).
- Bullets 1–2 lines, one sentence, ordered most relevant/impressive first; no personal pronouns; no
  terminal periods; digits rather than spelled-out numbers.
- Cut adjectives and adverbs that carry no evidence — if a claim needs "excellent" to sound
  impressive, it is not yet evidence.
- **"Your resume is not your job description"**: duties are not accomplishments. This is the single
  most load-bearing idea we took.
- **"Why integration matters"**: do not throw a parts list at the reader. How the pieces were
  integrated to achieve something is the part that demonstrates technical ability.
- Skills are things actually used, repeated in the bullets, comma-separated, correctly capitalized —
  never soft skills, never assumed tooling (IDEs, operating systems, Git *hosting* sites).
- Tailor per application; the resume has to show you can do *this* job.

**The research already cited at the top of `philosophy.ts`** (Randazzo 2020; UC Berkeley; Harvard
MCCS; NACE Job Outlook 2026; Yale OCS; Neumark/Burn/Button) governs *selection* rather than
phrasing: what earns space on the page, how recency and relevance trade off, and why coverage of
stated requirements is checked before space is optimized.

### What we deliberately did not take

The wiki also gives typography and layout rules — fonts, margins, 0.4-inch minimums, right-aligned
dates, en dashes, one page per decade of experience. Those are **not** in `RESUME_GUIDANCE`, because
ApplyGo's renderer owns them deterministically in `renderResumeHtml` and `LayoutSpec`. Instructing a
language model to control typography it cannot see would be noise at best and conflicting
instructions at worst.

Similarly, advice aimed at the *person* rather than the document (networking, timelines, how to
choose a degree) is out of scope for a document generator.

## How the rules are actually enforced

Prompting alone cannot guarantee a model did not fabricate, so the claims that matter are checked in
code, in `normalizePlan`:

1. **Cited evidence must trace back to the profile.** A `proven` coverage claim whose supporting
   text shares almost no vocabulary with the candidate's record is demoted. This is a content-word
   overlap test rather than exact matching, because the model is *asked* to paraphrase and honest
   paraphrase shares few exact strings.
2. **A requirement's own distinctive vocabulary must appear in the record.** The first check asks
   "is this evidence real?", which a model can satisfy while still citing the wrong thing — quoting
   genuine Plotly work as proof of a `D3.js` requirement passes it, because every word of the quote
   really is in the profile. So a `proven` claim additionally has to show that the requirement names
   something the record actually mentions. When it does not, the grade becomes `partial`: there is
   real adjacent experience, it simply is not the named thing, and saying so is more useful to the
   candidate than either silence or a lie.
3. **Unproven requirements reach the writer as an explicit prohibition**, not as an omission. Left
   implicit, a writer that knows the target wants Kubernetes will reliably find some way to gesture
   at Kubernetes.

The rule this produces, stated plainly: **adjacent experience is never upgraded into exact
experience.** ApplyGo may notice that related work exists, and may ask the candidate whether the
exact thing also happened — but it may not answer that question on their behalf.

## Profile is not resume copy

The canonical `CareerProfile` is a **factual evidence base**, not a set of polished sentences. An
accomplishment is stored with its context, action, technologies, scope, collaborators, outcome, and
metrics as separate fields, so that different target roles can draw different resumes from the same
underlying fact.

Deliberately keeping these separate is what makes the whole system work:

- **Profile** = source material. Exhaustive, structured, never trimmed for length.
- **Resume** = a job-specific *presentation* of a selected subset of it.

Optimizing a stored profile entry into one permanently polished resume sentence would destroy the
detail every other resume needs.

## How the profile actually improves: Strengthen Profile

Improvement is driven by real jobs, not by a generic audit. The full workflow, its stages, its
persisted artifacts, and its downstream consumers are documented in
[Strengthen Profile](../workflow/strengthen-profile.md).

The short version, and why it is shaped this way:

- A generic "what's missing from your profile?" pass has no basis for ranking one gap above another,
  so it asks broad questions the candidate has little reason to answer.
- A specific posting supplies that ranking for free. It says which requirements matter; comparing
  them against the record says exactly where the record is thin.
- Answers are merged into the **canonical profile**, not stored against the job. So evidence
  uncovered while looking at job A is already present when job B is analyzed.
- The number of questions is therefore expected to **fall** as the profile fills in. That is the
  feature succeeding, not running out of ideas.
