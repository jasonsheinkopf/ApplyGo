# Complete agent workflow

This document maps the workflow implemented by the Cloudflare Worker and D1 application in
`cloudflare/`. It is the most complete runtime in this repository. The smaller local Python
application has profile, job, and fit-assessment primitives, but does not implement the company
discovery, two-tier screening, or application-preparation flow shown here.

Solid arrows and borders are current behavior. Dashed arrows and nodes are planned behavior from
the product and roadmap documents. In particular, ApplyGo does **not** currently submit an
application, monitor messages, or model interviews, offers, or an accepted job.

## End-to-end workflow

Database cylinders are intentionally repeated beside the step that reads or writes them. Every
cylinder with the same label is the **same underlying store**, not a copy or a new database. This
local-reference convention keeps persistence explicit without routing long database arrows across
the workflow. A detailed table-to-field map remains below the diagram.

```mermaid
flowchart TD
    START[Start or revise search]:::agent
    SOURCES[/Human uploads documents and adds notes/]:::human
    PROFILE_LLM[LLM_PROFILE_EXTRACT<br/>profile.structure]:::llm
    MATCH_PROFILE[buildMatchProfile]:::code
    ROLES_LLM[LLM_ROLE_ANALYSIS<br/>roles.analyze]:::llm
    ADZUNA[(Adzuna job-search API)]:::external
    COMPANY_DISCOVER[Search real postings; aggregate employers]:::code
    COMPANY_IDENT[Canonicalize name; dedupe on match key]:::code
    COMPANY_RESOLVE[Website waterfall: evidence, then guess,<br/>each confirmed against page evidence]:::code
    WEBSITE_LLM[LLM_WEBSITE_RESOLVE<br/>companies.resolve_website<br/>search-grounded; only if deterministic fails]:::llm
    COMPANY_CHECK[Classify identity + job source; enforce invariants]:::code
    SCAN{Human starts company-board scan}:::human
    subgraph BOARD_STORAGE_ROW[ ]
      direction LR
      BOARD[Resolve ATS and fetch official board jobs]:::code
      C_UPDATE[(COMPANY STORE)]:::db
      BOARD -->|write scan metadata| C_UPDATE
    end
    subgraph ATS_OFFSET_COLUMN[ ]
      direction TB
      ATS_SPACER[ ]:::spacer
      ATS[(Official company ATS APIs)]:::external
      ATS_SPACER ~~~ ATS
    end
    subgraph PREFILTER_STORAGE_ROW[ ]
      direction RL
      P_PREFILTER[(PROFILE STORE)]:::db
      PREFILTER[Location and role prefilter]:::code
      P_PREFILTER -->|roles + locations| PREFILTER
    end
    DEDUPE{company_id + external_id already seen?}:::code
    ASSESS{Human starts job assessment}:::human
    SCREEN_LLM[LLM_JOB_SCREEN<br/>fit.screen]:::llm
    SCREEN_RESULT{Keep?}:::code
    subgraph FIT_INPUT_ROW[ ]
      direction LR
      P_FIT[(PROFILE STORE)]:::db
      FIT_LLM[LLM_JOB_FIT<br/>fit.assess]:::llm
      J_FIT_PIPE[(JOB STORE)]:::db
      P_FIT -->|profile + preferences| FIT_LLM
      J_FIT_PIPE -->|screened_in jobs| FIT_LLM
    end
    subgraph SCORE_REJECT_COLUMN[ ]
      direction TB
      SCORE[Map score to strong, possible, or reject]:::code
      REJECTED("REJECTED STATE<br/>Status: reject<br/>Score: 0 or model score<br/>Reason: saved<br/>Missing: retained<br/>Fit facts: retained<br/>Screened at: retained<br/>Assessed at: now<br/>Interested at: null<br/>Requirements: none<br/>Resume ID: none<br/>Cover letter ID: none<br/>Applied at: null<br/>Outcome: rejected"):::terminal
      SCORE -->|reject| REJECTED
    end
    REVIEW{Human reviews recommended job}:::human
    INTERESTED[Interested job]:::agent
    GAP_LLM[LLM_REVIEW_QUESTION<br/>review.question]:::llm
    GAP_ANSWER[/Human answers job-specific question/]:::human
    REQUIREMENTS_LLM[LLM_REQUIREMENTS<br/>resume.requirements]:::llm
    BASE_LLM[LLM_RESUME_BASE<br/>resume.select_base]:::llm
    PLAN_LLM[LLM_EVIDENCE_PLAN<br/>resume.plan_evidence]:::llm
    RESUME_LLM[LLM_RESUME_COMPOSE<br/>resume.build]:::llm
    RENDER[Render, check, and revise layout]:::code
    DESIGN_LLM[LLM_RESUME_DESIGN_REVIEW<br/>resume.design_review]:::llm
    LETTER_LLM[LLM_COVER_LETTER<br/>cover_letter.write]:::llm
    MATERIAL_REVIEW{Human reviews application materials}:::human
    FORM[/Human opens employer application form/]:::human
    FORM_LLM[LLM_APPLICATION_MATCH<br/>application.answers]:::llm
    FILL[Fill supported fields; leave unknowns to human]:::code
    SUBMIT{Human reviews and submits}:::human
    EMPLOYER[(Employer application site)]:::external
    MARK{Human marks job applied}:::human
    APPLIED("APPLIED STATE<br/>Status: applied<br/>Score: retained<br/>Reason: retained<br/>Missing: retained<br/>Fit facts: retained<br/>Screened at: retained<br/>Assessed at: retained<br/>Interested at: retained<br/>Requirements: retained or none<br/>Resume ID: present or none<br/>Cover letter ID: present or none<br/>Applied at: now<br/>Outcome: applied"):::terminal
    FUTURE[Planned status monitoring, interviews, and offers]:::planned
    ACCEPTED([Planned accepted job]):::plannedTerminal

    START --> SOURCES --> PROFILE_LLM --> MATCH_PROFILE --> ROLES_LLM --> COMPANY_DISCOVER
    COMPANY_DISCOVER <-->|postings| ADZUNA
    COMPANY_DISCOVER --> COMPANY_IDENT --> COMPANY_RESOLVE
    COMPANY_RESOLVE -->|deterministic tiers failed| WEBSITE_LLM
    WEBSITE_LLM -->|proposed URL, re-verified before trust| COMPANY_CHECK
    COMPANY_RESOLVE -->|confirmed| COMPANY_CHECK
    COMPANY_CHECK --> SCAN --> BOARD
    C_UPDATE ~~~ ATS_SPACER
    BOARD <-->|board jobs| ATS
    BOARD --> PREFILTER --> DEDUPE
    DEDUPE -->|insert new job or backfill description| J_WRITE
    J_WRITE -->|unassessed jobs| ASSESS
    ASSESS --> SCREEN_LLM --> SCREEN_RESULT
    FIT_LLM --> SCORE -->|strong or possible| REVIEW
    SCREEN_RESULT ~~~ REVIEW
    SCREEN_RESULT -->|no| REJECTED
    REVIEW -->|Reject| REJECTED
    REVIEW -->|Interested| INTERESTED
    INTERESTED --> GAP_LLM --> GAP_ANSWER --> REQUIREMENTS_LLM --> PLAN_LLM --> RESUME_LLM --> RENDER
    INTERESTED --> BASE_LLM --> PLAN_LLM
    RENDER --> DESIGN_LLM -->|layout or wording revision| RENDER
    INTERESTED --> LETTER_LLM
    RENDER --> MATERIAL_REVIEW
    LETTER_LLM --> MATERIAL_REVIEW
    MATERIAL_REVIEW --> FORM --> FORM_LLM --> FILL --> SUBMIT --> EMPLOYER --> MARK --> APPLIED
    APPLIED -.-> FUTURE -.-> ACCEPTED

    P_WRITE[(PROFILE STORE<br/>candidate_profiles, source_documents,<br/>candidate_evidence, application_answers)]:::db
    P_RESUME[(PROFILE STORE)]:::db
    P_FORM[(PROFILE STORE)]:::db
    C_WRITE[(COMPANY STORE<br/>companies)]:::db
    J_WRITE[(JOB STORE<br/>job_postings)]:::db
    J_REVIEW[(JOB STORE)]:::db
    J_RESUME[(JOB STORE)]:::db
    J_REQUIREMENTS_SAVE[(JOB STORE)]:::db
    J_FORM[(JOB STORE)]:::db
    J_APPLIED[(JOB STORE)]:::db
    F_WRITE[(FEEDBACK STORE<br/>job_feedback)]:::db
    F_SCREEN[(FEEDBACK STORE)]:::db
    R_READ[(RESUME STORE<br/>resumes + R2 PDFs)]:::db
    R_WRITE[(RESUME STORE)]:::db
    R_FORM[(RESUME STORE)]:::db
    L_WRITE[(COVER LETTER STORE<br/>cover_letters)]:::db
    L_FORM[(COVER LETTER STORE)]:::db

    SOURCES -->|write files and notes| P_WRITE
    MATCH_PROFILE -->|write structured profile + match profile| P_WRITE
    P_WRITE -->|profile + preferences| ROLES_LLM
    ROLES_LLM -->|write role analysis + desired roles| P_WRITE
    P_WRITE -->|search terms from role analysis| COMPANY_DISCOVER
    COMPANY_CHECK -->|write company: identity + job-source state| C_WRITE
    C_WRITE -->|companies due to scan| SCAN
    F_SCREEN -->|confirmed rejection reasons| SCREEN_LLM
    SCREEN_RESULT -->|write screened_in or screened_out| J_FIT_PIPE
    SCORE -->|write score, reason, missing, facts| J_FIT_PIPE
    J_REVIEW -->|recommended jobs| REVIEW
    REVIEW -->|write interested or reject| J_REVIEW
    REVIEW -->|typed rejection reason| F_WRITE
    GAP_ANSWER -->|write job_review evidence| P_RESUME
    J_RESUME -->|job description + requirements| REQUIREMENTS_LLM
    REQUIREMENTS_LLM -->|cache parsed requirements| J_REQUIREMENTS_SAVE
    R_READ -->|base resume| BASE_LLM
    RENDER -->|write resume JSON, checks, and PDF| R_WRITE
    LETTER_LLM -->|write letter HTML| L_WRITE
    P_FORM -->|profile + saved exact answers| FORM_LLM
    J_FORM -->|job context| FORM_LLM
    R_FORM -->|tailored resume| FORM_LLM
    L_FORM -->|cover letter| FORM_LLM
    MARK -->|write applied status and time| J_APPLIED

    classDef human fill:#fff4cc,stroke:#9a6b00,color:#2b2100,stroke-width:2px;
    classDef agent fill:#e9f2ff,stroke:#3569a8,color:#102a43;
    classDef llm fill:#efe7ff,stroke:#7048a8,color:#2d174d,stroke-width:2px;
    classDef external fill:#e8f7f0,stroke:#287a55,color:#163d2d;
    classDef db fill:#e8eef5,stroke:#445b73,color:#172b3d,stroke-width:2px;
    classDef code fill:#f4f4f4,stroke:#666,color:#222;
    classDef terminal fill:#dff5df,stroke:#267326,color:#123d12,stroke-width:2px,text-align:left;
    classDef planned fill:#fff,stroke:#777,color:#555,stroke-dasharray:5 5;
    classDef plannedTerminal fill:#fff,stroke:#267326,color:#267326,stroke-width:2px,stroke-dasharray:5 5;
    style BOARD_STORAGE_ROW fill:transparent,stroke:transparent
    style PREFILTER_STORAGE_ROW fill:transparent,stroke:transparent
    style ATS_OFFSET_COLUMN fill:transparent,stroke:transparent
    style FIT_INPUT_ROW fill:transparent,stroke:transparent
    style SCORE_REJECT_COLUMN fill:transparent,stroke:transparent
    classDef spacer fill:transparent,stroke:transparent,color:transparent,width:1px,height:14px;
```

## Diagram shape and color key

The visual vocabulary is consistent across both diagrams in this document.

| Appearance | Mermaid shape/class | Meaning |
|---|---|---|
| Yellow parallelogram | `[/.../]`, `human` | Human-provided data or a human action. |
| Yellow diamond | `{...}`, `human` | Human decision or approval checkpoint. |
| Blue rectangle | `[...]`, `agent` | Application UI or orchestration logic. |
| Purple rectangle | `[...]`, `llm` | One explicit LLM task/prompt call. Repeated use of the same node means the same task is called again. |
| Gray rectangle | `[...]`, `code` | Deterministic code, transformation, validation, rendering, or filtering. |
| Gray diamond | `{...}`, `code` | Deterministic branch or threshold. |
| Pale-green cylinder | `[(...)]`, `external` | External system or authoritative company/ATS source. |
| Blue-gray cylinder | `[(...)]`, `db` | Local reference to current persistent D1 or R2 storage. Repeated cylinders with the same store name are the same database, placed near each reader/writer to avoid crossed lines. |
| Green rounded rectangle | `(...)`, `terminal` or `row` | Complete workflow-state snapshot. Every green state card uses the fixed state order below. |
| White dashed shape | `planned`, `plannedRow`, or `plannedTerminal` | Planned behavior or storage that is not operational today. Shape meaning otherwise follows the rows above. |
| Solid arrow | `-->` | Current control flow or data movement. Edge text names the data or transition. |
| Dashed arrow | `-.->` | Planned control flow or data movement. |
| Two-headed arrow | `<-->` | Current request/response exchange with an external system. |

Green state cards are deliberately verbose: each is a complete state vector, not a list of only
the fields changed by the immediately preceding transition. Labels are left-aligned and always use
this order:

| Order | Alias | State variable | Description | Empty value |
|---:|---|---|---|---|
| 1 | `Status` | `job_postings.fit_status` | The job's current pipeline stage (`unassessed`, `screened_in/out`, `strong`/`possible`/`reject`, `interested`, `applied`). Drives which tab/list the job shows up in. | `unassessed` for a new job |
| 2 | `Score` | `job_postings.fit_score` | The 0-100 fit score `LLM_JOB_FIT` gave this posting against the candidate's profile. | `null` |
| 3 | `Reason` | `job_postings.fit_reason` | One sentence explaining the score -- either the model's explanation, or the human's typed rejection reason if they rejected it themselves. | `none` (stored as an empty string) |
| 4 | `Missing` | `job_postings.fit_missing_json` | Specific requirements the posting states that the profile doesn't evidently meet, as a list of short strings. | `[]` |
| 5 | `Fit facts` | `job_postings.fit_detail_json` | Quick-glance answers to the candidate's own "what I care about" topics for this posting (e.g. remote/hybrid, pay, years required). | `{}` |
| 6 | `Screened at` | `job_postings.screened_at` | When the cheap screen (`LLM_JOB_SCREEN`) last ran on this posting. | `null` |
| 7 | `Assessed at` | `job_postings.assessed_at` | When the strong-tier fit assessment (or a human reject) last wrote to this row. | `null` |
| 8 | `Interested at` | `job_postings.interested_at` | When the human marked this job Interested. | `null` |
| 9 | `Requirements` | `job_postings.requirements_json` | The posting's parsed requirements (must-have/preferred/etc.), cached so resume generation doesn't re-extract them on every revision. | `none` (stored as `{}`) |
| 10 | `Resume ID` | related job-tailored `resumes.id` | Whether a tailored resume has been generated for this job yet. | `none` |
| 11 | `Cover letter ID` | related `cover_letters.id` | Whether a tailored cover letter has been generated for this job yet. | `none` |
| 12 | `Applied at` | `job_postings.applied_at` | When the human clicked Mark Applied. | `null` |
| 13 | `Outcome` | conceptual outcome state | Diagram-only summary of where this card sits in the job's lifecycle; not a real column. | `none`; only `rejected` and `applied` are representable today, while later outcomes are planned |

`retained` means the preceding value remains unchanged; `present` means a related row exists;
`now` means the transition writes the current timestamp. `Outcome` makes the missing post-application
lifecycle visible without pretending that a corresponding database column exists.

## State and data key

| Diagram term | Actual representation | Produced or consumed by |
|---|---|---|
| StructuredProfile | `candidate_profiles.structured_json` | Saved by `saveStructuredProfile`; drafted by `profile.structure` |
| Preferences | `preferences_json.desired_locations`, `dealbreakers`, `care_about`, `care_about_topics`, `role_analysis`, `desired_roles` | `saveDesiredRoles` saves the first four; `deriveCareAboutTopics` derives `care_about_topics`; `analyzeDesiredRoles` derives `role_analysis` and `desired_roles` together -- the latter is never saved directly by the user |
| Match profile | `candidate_profiles.match_profile` | Deterministically rebuilt by `buildMatchProfile` on every structured-profile save |
| Company identity | `companies.source_name` (raw), `name` (cleaned display), `name_key` (dedupe) | `companyIdentity` in `cloudflare/src/identity.ts` |
| Company identity state | `companies.identity_status` — `pending`/`verified`/`ambiguous`/`unresolved`/`not_a_company`/`dismissed` | `resolveWebsiteDeterministic`, reconciled by `reconcileCompanyState` |
| Company job-source state | `companies.job_source_status` — `pending`/`supported`/`unsupported_ats`/`careers_only`/`no_board`/`board_unreachable` | `resolveBoard` + `detectAtsFromUrl`, reconciled by `reconcileCompanyState` |
| Website evidence | `companies.website_source`, `website_confidence`, `website_evidence` | `scoreSiteMatch` in `cloudflare/src/resolver.ts` |
| Company scan identity | `companies.ats_provider` + `ats_token` | `resolveBoard`; cached after resolution |
| Raw/discovered job | `job_postings` listing fields plus `raw_description` | `fetchBoardJobs`, `fetchMissingDescriptions`, and `scanOneCompany` |
| Job identity | Partial unique index on `(company_id, external_id)` | `INSERT OR IGNORE` in `scanOneCompany` |
| Quick result | `ScreenResult { id, keep, note }` | `screenJobsBatch` |
| Fit evaluation | `FitResult { id, score, reason, missing, facts }` | `assessJobFitBatch`; persisted on `job_postings` |
| Human job decision | `fit_status=interested` or `fit_status=reject` | `setJobFit` |
| Job-specific evidence | `candidate_evidence(category='job_review', job_id, claim)` | Human answer saved by `createJobReviewAnswer` |
| Application packet | No single current record. It is the related tailored `resumes` row, optional `cover_letters` row, profile/application answers, and live form mapping. | Generated after an Interested decision |
| Application status | Only `fit_status='applied'` and `applied_at` currently exist | Human `setJobFit(action='applied')` |

## LLM and prompt calls

All calls route through `cloudflare/src/llm.ts`; task/provider/model selection is defined in
`cloudflare/src/tasks.ts`. Calls are also written to `llm_traces` unless tracing is disabled.

| Alias | Task and implementation | Prompt inputs | Output and persistence |
|---|---|---|---|
| LLM_PROFILE_EXTRACT | `profile.structure`; `generateProfile` in `cloudflare/src/index.ts` | Extracted source documents, notes, existing profile | `StructuredProfile` draft. It is persisted only after the human saves it. |
| LLM_ROLE_ANALYSIS | `roles.analyze`; `analyzeDesiredRoles` in `index.ts` | User-created `role_signal` evidence, the compact `match_profile`, desired locations, dealbreakers, and criteria (`care_about`) | Structured `{summary, roles: [{title, description}]}`. Saved directly (no draft/approve step) to `preferences_json.role_analysis`; `desired_roles`, the flat string every scoring/resume prompt reads, is deterministically re-derived from `roles` on every save. |
| LLM_CARE_TOPICS | `fit.care_about_topics`; `deriveCareAboutTopics` in `cloudflare/src/fit.ts` | Free-text `care_about` | Structured topic keys/labels/questions, stored inside `preferences_json`. |
| LLM_WEBSITE_RESOLVE | `companies.resolve_website`; `resolveWebsiteViaSearch` in `cloudflare/src/websearch.ts` | Canonical company name, location, and the job titles discovery actually saw for it | `{official_website, careers_url, confidence, reason}` via Claude's server-side web search. **The only model call in company discovery**, and only for a company the deterministic waterfall could not place. Its answer is never trusted as returned: `scanOneCompany` re-fetches the proposed URL and scores it with `scoreSiteMatch` before accepting, and anything under the confidence floor is stored as `ambiguous` rather than guessed. |
| LLM_JOB_SCREEN | `fit.screen`; `screenJobsBatch` in `fit.ts` | Compact `match_profile`, roles, confirmed rejection reasons, and batches containing job title/location (not description) | `{id, keep, note}`; stored as `screened_in` or `screened_out`. |
| LLM_JOB_FIT | `fit.assess`; `assessJobFitBatch` in `fit.ts` | Full structured profile, roles, dealbreakers, care-about topics, confirmed disqualifiers, and job descriptions | Score, reason, missing evidence, and facts; stored in `job_postings`. |
| LLM_REVIEW_QUESTION | `review.question`; `reviewJobQuestion` in `index.ts` | Job, structured profile, and prior job-review answers | One question. The question itself is not stored until the human submits an answer; then question and answer are stored together as evidence. |
| LLM_REQUIREMENTS | `resume.requirements`; `extractJobRequirements` in `cloudflare/src/philosophy.ts` | Job description | `JobRequirements`; cached in `job_postings.requirements_json`. |
| LLM_RESUME_BASE | `resume.select_base`; `decideResumeBase` in `index.ts` | Candidate profile, job, and available base resumes | Base resume ID and tailoring notes; consumed by the job-resume pipeline. |
| LLM_EVIDENCE_PLAN | `resume.plan_evidence`; `planEvidence` in `philosophy.ts` | Profile evidence, parsed job requirements, base resume, job-review evidence | `EvidencePlan`; persisted as `resumes.plan_json`. |
| LLM_RESUME_COMPOSE | `resume.build`; `composeResumeDoc` in `cloudflare/src/resume.ts` | Structured profile, instructions/evidence plan, and optional base content | `ResumeDoc`; stored in `resumes.content_json`, then rendered deterministically. |
| LLM_RESUME_DESIGN_REVIEW | `resume.design_review`; `reviewResumeDesign` in `resume.ts` | Rendered resume image and current layout | Design critique and layout adjustments; final critique/layout/checks persist on `resumes`. |
| LLM_COVER_LETTER | `cover_letter.write`; `composeCoverLetter` in `index.ts` | Job, profile, job-review evidence, optional tailored-resume contact line | Letter body, deterministically rendered and upserted to `cover_letters.content_html`. |
| LLM_APPLICATION_MATCH | `application.answers`; `matchApplication` in `index.ts` | Unresolved, non-sensitive live fields plus profile and optional job-review context; exact saved answers and contact fields are resolved before this call | Generated field values join deterministic/bank values; unresolved fields are returned as missing. The response can also identify job resume and cover-letter artifacts. It does not submit the form. |

The implementation also supports master-resume creation and explicit resume revision. Those reuse
the resume composition/render/review machinery and are supporting loops rather than separate
stages on the main job path.

## Persistent stores

| Store | Current contents and important writes |
|---|---|
| Candidate/profile D1 tables | `candidate_profiles` stores summary, preferences, structured profile, and compact match profile. `source_documents` stores metadata/extracted text while the original file is in R2. `candidate_evidence` stores notes, role signals, and job-review answers. `application_answers` stores exact reusable form values. |
| `companies` | One profile-scoped watch-list row per normalized `name_key`; website verification status, ATS identity, scan result, open-job count, and timestamps mutate on the same row. |
| `job_postings` | The raw listing and all machine/human pipeline state live on one row. Rescans do not create a history table. The unique `(company_id, external_id)` index prevents duplicate scanned jobs; manual jobs have neither field and are outside that constraint. |
| `job_feedback` | Durable human-confirmed rejection reasons. AI rejection reasons do not enter this learning loop automatically. |
| `resumes` + R2 | Resume JSON, job link, selected template/layout, checks, critique, evidence plan, revision, and PDF object key. `is_master` identifies the profile archive resume. |
| `cover_letters` | At most one generated HTML cover letter per job; regeneration replaces it. |
| `fit_assessments` | Present in the original schema, but the current two-tier path writes fit results directly to `job_postings`; it does not insert assessment-history rows here. |
| `llm_traces` | Prompt, response, task, provider/model/tier, token/cost/latency/error metadata for model calls. |
| Application history | **Gap:** there is no application entity, receipt, status-event history, interview, offer, or accepted-outcome table. `job_postings.applied_at` is the entire current tracking model. |

## Job pipeline: screening to outcome

Every posting moves one way through this diagram. Two shapes now carry the meaning: a **purple
rectangle** is one LLM call with one prompt (reused where the same call is invoked more than
once), and a **green rounded rectangle** is a complete workflow-state snapshot using the fixed 13-variable
order defined in the key above. There is no separate "state" box — `unassessed`, `screened_in`, `recommended`,
`interested`, and `applied` are not different kinds of thing, they're the same `job_postings` row
with a different `fit_status` value, so they are drawn as consistent rounded state cards.
Deterministic checks (gray) and human choices (yellow) move a row from one card to the next.

```mermaid
flowchart TD
    ROW_NEW("NEW JOB<br/>Status: unassessed<br/>Score: null<br/>Reason: none<br/>Missing: []<br/>Fit facts: {}<br/>Screened at: null<br/>Assessed at: null<br/>Interested at: null<br/>Requirements: none<br/>Resume ID: none<br/>Cover letter ID: none<br/>Applied at: null<br/>Outcome: none"):::row
    ROW_NEW --> SCREEN_LLM[LLM_JOB_SCREEN<br/>fit.screen — cheap model]:::llm
    SCREEN_LLM -->|keep=false| ROW_SCREENED_OUT("SCREENED OUT<br/>Status: screened_out<br/>Score: null<br/>Reason: screen note<br/>Missing: []<br/>Fit facts: {}<br/>Screened at: now<br/>Assessed at: null<br/>Interested at: null<br/>Requirements: none<br/>Resume ID: none<br/>Cover letter ID: none<br/>Applied at: null<br/>Outcome: rejected"):::row
    SCREEN_LLM -->|keep=true| ROW_SCREENED_IN("SCREENED IN<br/>Status: screened_in<br/>Score: null<br/>Reason: screen note or none<br/>Missing: []<br/>Fit facts: {}<br/>Screened at: now<br/>Assessed at: null<br/>Interested at: null<br/>Requirements: none<br/>Resume ID: none<br/>Cover letter ID: none<br/>Applied at: null<br/>Outcome: none"):::row

    ROW_SCREENED_IN --> FIT_LLM[LLM_JOB_FIT<br/>fit.assess — strong model<br/>one call: score, reason,<br/>missing evidence, and facts]:::llm
    FIT_LLM --> THRESHOLD{"verdictForScore(score):<br/>below the reject cutoff?"}:::code
    THRESHOLD -->|yes, score &lt; 40| ROW_DISCARDED("AUTO REJECTED<br/>Status: reject<br/>Score: model score<br/>Reason: model reason<br/>Missing: model missing[]<br/>Fit facts: model facts{}<br/>Screened at: retained<br/>Assessed at: now<br/>Interested at: null<br/>Requirements: none<br/>Resume ID: none<br/>Cover letter ID: none<br/>Applied at: null<br/>Outcome: rejected"):::row
    THRESHOLD -->|no, score &gt;= 40| ROW_RECOMMENDED("RECOMMENDED<br/>Status: strong or possible<br/>Score: model score<br/>Reason: model reason<br/>Missing: model missing[]<br/>Fit facts: model facts{}<br/>Screened at: retained<br/>Assessed at: now<br/>Interested at: null<br/>Requirements: none<br/>Resume ID: none<br/>Cover letter ID: none<br/>Applied at: null<br/>Outcome: none"):::row

    ROW_RECOMMENDED --> HUMAN_DECISION{Human: Interested or Reject}:::human
    HUMAN_DECISION -->|Reject, optional typed reason| ROW_REJECTED("HUMAN REJECTED<br/>Status: reject<br/>Score: 0<br/>Reason: human reason or Not a fit.<br/>Missing: retained<br/>Fit facts: retained<br/>Screened at: retained<br/>Assessed at: now<br/>Interested at: null<br/>Requirements: none<br/>Resume ID: none<br/>Cover letter ID: none<br/>Applied at: null<br/>Outcome: rejected"):::row
    HUMAN_DECISION -->|Interested| ROW_INTERESTED("INTERESTED<br/>Status: interested<br/>Score: retained<br/>Reason: retained<br/>Missing: retained<br/>Fit facts: retained<br/>Screened at: retained<br/>Assessed at: retained<br/>Interested at: now<br/>Requirements: none<br/>Resume ID: none<br/>Cover letter ID: none<br/>Applied at: null<br/>Outcome: none"):::row

    ROW_INTERESTED --> BASE_LLM[LLM_RESUME_BASE<br/>resume.select_base<br/>optional: only if prior<br/>versions exist]:::llm
    ROW_INTERESTED --> REQ_LLM[LLM_REQUIREMENTS<br/>resume.requirements<br/>cached: requirements_json]:::llm
    REQ_LLM --> PLAN_LLM[LLM_EVIDENCE_PLAN<br/>resume.plan_evidence]:::llm
    BASE_LLM --> COMPOSE_LLM[LLM_RESUME_COMPOSE<br/>resume.build]:::llm
    PLAN_LLM --> COMPOSE_LLM
    COMPOSE_LLM --> RENDER[Deterministic render + screenshot]:::code
    RENDER --> DESIGN_LLM[LLM_RESUME_DESIGN_REVIEW<br/>resume.design_review — vision model<br/>critique, layout_adjustments,<br/>needs_content_revision out]:::llm
    DESIGN_LLM --> NEEDS_REVISION{needs_content_revision?}:::code
    NEEDS_REVISION -->|yes: rewrite wording| COMPOSE_LLM
    NEEDS_REVISION -->|no: layout only| RERENDER[Deterministic re-render<br/>at adjusted layout]:::code
    COMPOSE_LLM -->|rewritten draft| PAGE_CHECK{"Still over the page budget?<br/>deterministic PDF check"}:::code
    RERENDER --> PAGE_CHECK
    PAGE_CHECK -->|yes, attempts &lt; 3| RENDER
    PAGE_CHECK -->|no, or 3 attempts used| ROW_RESUME_READY("RESUME READY<br/>Status: interested<br/>Score: retained<br/>Reason: retained<br/>Missing: retained<br/>Fit facts: retained<br/>Screened at: retained<br/>Assessed at: retained<br/>Interested at: retained<br/>Requirements: present<br/>Resume ID: present<br/>Cover letter ID: none<br/>Applied at: null<br/>Outcome: none"):::row
    ROW_RESUME_READY --> HUMAN_RESUME_REVIEW{Human reviews the resume}:::human
    HUMAN_RESUME_REVIEW -->|types a comment, clicks Revise| RENDER

    ROW_INTERESTED --> LETTER_LLM[LLM_COVER_LETTER<br/>cover_letter.write<br/>single call — no review loop]:::llm
    LETTER_LLM --> LETTER_RENDER[Deterministic render to HTML]:::code
    LETTER_RENDER --> ROW_LETTER_READY("COVER LETTER READY<br/>Status: interested<br/>Score: retained<br/>Reason: retained<br/>Missing: retained<br/>Fit facts: retained<br/>Screened at: retained<br/>Assessed at: retained<br/>Interested at: retained<br/>Requirements: retained or none<br/>Resume ID: present or none<br/>Cover letter ID: present<br/>Applied at: null<br/>Outcome: none"):::row

    HUMAN_RESUME_REVIEW -->|approved| APPLY_STEP{Human fills the live form<br/>and marks Applied}:::human
    ROW_LETTER_READY --> APPLY_STEP
    APPLY_STEP --> ROW_APPLIED("APPLIED<br/>Status: applied<br/>Score: retained<br/>Reason: retained<br/>Missing: retained<br/>Fit facts: retained<br/>Screened at: retained<br/>Assessed at: retained<br/>Interested at: retained<br/>Requirements: retained or none<br/>Resume ID: present or none<br/>Cover letter ID: present or none<br/>Applied at: now<br/>Outcome: applied"):::row
    ROW_APPLIED -.->|planned| ROW_ACCEPTED(["accepted"]):::plannedRow
    ROW_APPLIED -.->|planned| ROW_CLOSED(["rejected / withdrawn"]):::plannedRow

    classDef human fill:#fff4cc,stroke:#9a6b00,color:#2b2100,stroke-width:2px;
    classDef llm fill:#efe7ff,stroke:#7048a8,color:#2d174d,stroke-width:2px;
    classDef code fill:#f4f4f4,stroke:#666,color:#222;
    classDef row fill:#dff5df,stroke:#267326,color:#123d12,stroke-width:2px,text-align:left;
    classDef plannedRow fill:#fff,stroke:#267326,color:#267326,stroke-width:2px,stroke-dasharray:5 5;
```

Reading the resume loop exactly (the part with real cycles): `buildJobResume` composes once
(`COMPOSE_LLM`, fed by the optional base-selection call and the requirements→evidence-plan
chain), then hands off to a review loop that runs automatically, before a human ever sees
anything. Each pass through that loop renders the current draft and screenshots it, asks the
vision model to critique it, and then either rewrites the wording (another `COMPOSE_LLM` call,
same prompt/task, same node) or just nudges the layout — either way, a deterministic page-count
check decides whether another pass is worth it. That's capped at 3 automatic passes
(`reviseUntilFits`'s `maxAttempts`); after that it ships with a note saying it's still over
budget rather than looping forever. Only after this loop settles does anything get written to the
`resumes` row and shown to the candidate. From there, "Revise this version" is a human-triggered
re-entry into the exact same loop — same design-review call, same rewrite-or-adjust branch, same
page-count gate — just seeded with the human's comment instead of running unattended. So yes,
it's genuinely two LLM calls cycling against each other (`LLM_RESUME_COMPOSE` ↔
`LLM_RESUME_DESIGN_REVIEW`), and it does run more than once by design. The cover letter does not
share any of this: `LLM_COVER_LETTER` is one call, rendered deterministically to HTML, with no
critique step and no revision endpoint at all today.

This is the target shape, and most of it already matches the code, but a few things are cleaner
here than what's actually implemented:

- **Restore still exists.** `POST /jobs/:id {action:"restore"}` resets any `fit_status='reject'`
  row — whether `LLM_JOB_FIT` auto-scored it under the cutoff or a human rejected it — back to
  `unassessed`, and the same button undoes a `screened_out`. This diagram assumes that path is
  gone, so `screened_out`, `discarded`, and `rejected` are drawn as true dead ends.
- **There's no separate `keep` column.** The cheap screen's `keep` boolean is never stored on its
  own; it's translated straight into `fit_status` (`screened_in`/`screened_out`) in the same
  write. Same for the strong tier: score, bucket, reason, missing evidence, and facts all land in
  one `UPDATE` — there's no intermediate row where the score exists but the bucket doesn't yet.
  So "cheap screen" and "real screen" don't need new variable names; the code's own task names
  (`fit.screen`, `fit.assess`) and the one shared `fit_status` column already cover it.
- **The single score already exists, the single threshold mostly does.** `FitResult.score` is
  the real 0-100 number `LLM_JOB_FIT` returns, but `verdictForScore` (`cloudflare/src/fit.ts`)
  still labels it `strong` (≥70), `possible` (40-69), or `reject` (<40) and writes that label as
  `fit_status`. The Jobs UI already queries `strong` and `possible` as one pool
  (`fit_status IN ('strong','possible')`) and lets the human sort/filter by score from there, so
  this diagram drops the strong/possible split from the pipeline itself — `discarded` vs.
  `recommended` is one threshold (currently the 40-point reject cutoff), not two.
  `strong`/`possible` remain in the schema purely as a cosmetic badge on the recommended pool.
- **Un-interesting a job still exists too.** `action:"uninterested"` moves a job from
  `interested` back to whatever `verdictForScore` says its stored score implies (or
  `unassessed` if never scored). That backward edge, and `applied` → `interested` un-apply, are
  real and stay in the UI; they're left off this diagram because its purpose is the one-way
  pipeline a posting travels through, not every human override.
- **Applying is a whole subsystem drawn as one box here.** `APPLY_STEP` stands in for the
  extension field-matching, human review, and Mark Applied sequence already diagrammed in full at
  the top of this document (`LIVE_FORM` through `MARK_APPLIED`) — it isn't repeated at this level
  of detail twice.

`fit_status` values today, mapped to the diagram above:

| Diagram node | `fit_status` value(s) | Notes |
|---|---|---|
| unassessed | `unassessed` | |
| screened_out | `screened_out` | |
| screened_in | `screened_in` | |
| discarded | `reject` | Auto: score set by `verdictForScore`, no human involved |
| recommended | `strong`, `possible` | Same visible pool; the split is cosmetic |
| rejected | `reject` | Human: score forced to 0, reason optional |
| interested | `interested` | |
| applied | `applied` | Current terminal state |
| accepted / rejected-or-withdrawn | *(none)* | Planned — no column exists yet |

There are still no separate `discovered`, `seen`, `deduplicated`, `documents_generated`,
`ready_to_apply`, `interviewing`, `offer`, `accepted`, or `closed` values. Discovery and
deduplication are represented by row existence and the unique index; document readiness is
represented by related-row existence. The remaining lifecycle states are architectural gaps.

## Company pipeline: discovery to job handoff

A company carries **two independent states**, and conflating them was a real defect rather than a
naming quibble: a company whose website is confirmed is a *verified company* even when ApplyGo
cannot read the ATS it hires through, because an unsupported ATS is a limitation of this app, not a
property of the employer.

| Axis | Column | Values |
|---|---|---|
| Who is this employer? | `identity_status` | `pending`, `verified`, `ambiguous`, `unresolved`, `not_a_company`, `dismissed` |
| Can we read their jobs? | `job_source_status` | `pending`, `supported`, `unsupported_ats`, `careers_only`, `no_board`, `board_unreachable` |

Job source is only meaningful downstream of a verified identity, so `pending` on an unresolved
company means "never attempted", not "checked and found nothing".

```mermaid
flowchart LR
    RAW[/Adzuna employer string/]:::human
    CANON[Canonicalize<br/>strip legal suffixes, ATS artifacts,<br/>entity codes]:::code
    JUNK{Names an employer<br/>at all?}:::code
    DEDUPE{Already known?<br/>match key}:::code
    T1[Tier 1: URLs discovery supplied]:::code
    T2[Tier 2: domain candidates<br/>from the cleaned name]:::code
    T3[Tier 3: fetch and score the page<br/>title, og:site_name, schema.org]:::code
    T4[LLM_WEBSITE_RESOLVE<br/>search-grounded, first scan only]:::llm
    VERDICT{Confidence >= floor?}:::code
    VERIFIED("identity_status = verified"):::row
    AMBIG("identity_status = ambiguous<br/>evidence retained"):::row
    UNRES("identity_status = unresolved<br/>retried automatically"):::row
    BOARD[Resolve job board<br/>stored URL patterns, then careers page,<br/>then slug guesses]:::code
    SUPPORTED("job_source = supported"):::row
    UNSUPPORTED("job_source = unsupported_ats<br/>board link shown"):::row
    CAREERS("job_source = careers_only"):::row
    NOBOARD("job_source = no_board"):::row
    IMPORT[Import postings]:::code
    PRESCREEN("Pre-screen — jobs<br/>shared with the Jobs page"):::row

    RAW --> CANON --> JUNK
    JUNK -->|no| NOTCO("identity_status = not_a_company"):::row
    JUNK -->|yes| DEDUPE
    DEDUPE -->|yes| MERGE[Merge into the existing company]:::code
    DEDUPE -->|no| T1 --> T2 --> T3 --> VERDICT
    T3 -->|nothing confirmed| T4 --> VERDICT
    VERDICT -->|yes| VERIFIED
    VERDICT -->|URL found, not confirmed| AMBIG
    VERDICT -->|nothing found| UNRES
    VERIFIED --> BOARD
    BOARD --> SUPPORTED
    BOARD --> UNSUPPORTED
    BOARD --> CAREERS
    BOARD --> NOBOARD
    SUPPORTED --> IMPORT -->|unit changes: companies to jobs| PRESCREEN

    classDef human fill:#fff4cc,stroke:#9a6b00,color:#2b2100,stroke-width:2px;
    classDef llm fill:#efe7ff,stroke:#7048a8,color:#2d174d,stroke-width:2px;
    classDef code fill:#f4f4f4,stroke:#666,color:#222;
    classDef row fill:#dff5df,stroke:#267326,color:#123d12,stroke-width:2px,text-align:left;
```

**Where AI enters, and where it deliberately does not.** Everything above is deterministic except
`LLM_WEBSITE_RESOLVE`. Company discovery uses no model to decide *which* companies are worth
watching — that judgment happens per job, in `fit.screen`/`fit.assess`, because almost any large
employer can hold a relevant role. The single model call exists for one question a model is
genuinely better at than code (which of several same-named organizations is this?), it is given
real web search rather than being asked to recall a domain, and its answer is re-verified
deterministically before it is trusted.

**Invariants.** `reconcileCompanyState` (`cloudflare/src/companystate.ts`) runs on every write, so
contradictory rows cannot be stored — a board URL cannot coexist with "no job board found", a
verified identity cannot lack a website, and a job source cannot be set on an unverified company.

**Counts.** `cloudflare/src/pipeline.ts` owns the funnel arithmetic and asserts that each stage's
outcomes sum to what entered it. `PRESCREEN_PREDICATE` is defined once there and imported by both
the Companies and Jobs endpoints, so the last node on Companies and the first node on Jobs are the
same rows by construction.

## Read-only MCP server

`mcp/` is a Model Context Protocol server that exposes ApplyGo's data to an MCP client such as
Claude Desktop: `search_companies`, `get_company`, `search_jobs`, `get_job`, `list_applications`,
`get_application_status`, `get_pipeline_summary`.

It cannot write. The guarantee is one check in `requireSession`: a credential with
`scope='read_only'` may only issue `GET`/`HEAD` requests. Because that sits at the single
authentication choke point, every mutating route is covered by construction, including routes added
later, and the restriction holds even against a modified client. The token cannot mint another
token. See `mcp/README.md` for setup.

## Human-in-the-loop checkpoints

- The human owns profile facts, preferences, role signals, locations, dealbreakers, and whether an
  LLM-generated profile or desired-role draft is saved.
- Company discovery and scanning are manually triggered. Companies can be added, dismissed,
  restored, retried, or deleted by the human.
- Assessment is manually triggered. The human chooses Interested or Reject; only a rejection
  reason they explicitly type becomes future model context.
- Resume and cover-letter generation happen only for a chosen job and remain reviewable and
  regenerable. The current database records generated checks and critique, but has no explicit
  `materials_approved` state.
- The extension fills application fields, but the human handles unresolved/sensitive fields,
  CAPTCHA, final review, and submission. Marking Applied is a separate manual action and is not
  proof that the employer accepted the form.

## Current, partial, and planned behavior

| Capability | Status | Evidence and limitation |
|---|---|---|
| Profile/evidence/preferences | **Current** | D1/R2 schema and profile endpoints in `index.ts`. |
| Structured search target | **Current** | Preferences plus deterministic `match_profile`; there is no single LLM-produced `target_profile` object. |
| Company discovery | **Current, human-triggered** | Real Adzuna postings, aggregated by employer. No model chooses which companies are worth watching. Search terms come from the saved role analysis and are editable. |
| Company identity resolution | **Current** | Deterministic canonicalization and a bounded domain waterfall, every candidate confirmed against page evidence before acceptance (`identity.ts`, `resolver.ts`). Measured on the real unresolved backlog, this resolves 34 of a 40-company sample the previous slug-only guess resolved none of. |
| Search-grounded website fallback | **Current, first scan only** | `companies.resolve_website` via Claude's server-side web search, for companies the deterministic tiers cannot place. Never accepted on the model's word: the proposed URL is re-fetched and scored before it is trusted. |
| Resumable discovery | **Current** | Per-`(term, location)` cursors persist across runs; one press continues until the queries are exhausted and waits out provider rate limits. A dropped progress stream loses no work. |
| Read-only MCP server | **Current** | `mcp/`, seven read tools, enforced read-only at ApplyGo's authentication choke point. |
| Recurring company scans | **Partially implemented** | A once-per-calendar-day eligibility guard exists, and repeat clicks resume work, but there is no scheduler/cron trigger in the current Worker. |
| Official career-board discovery | **Current** | Deterministic resolution and public APIs for four supported ATS providers. Unsupported boards are recorded as `ats_provider='none'`; there is no generic browser scraper fallback. |
| Job dedupe and cheap prefilter | **Current** | Unique company/external ID, deterministic location/role filtering, then cheap-model screening. |
| Strong fit evaluation and explainability | **Current** | Score, verdict, reason, missing evidence, and structured facts persist on each posting. |
| Human recommendation review and learning | **Current** | Strong/possible list, Interested/Reject, and explicit rejection feedback loop. There is no `Skip` state; leaving a job undecided preserves its current verdict. |
| Tailored resume and cover letter | **Current** | Evidence planning, generation, deterministic checks/rendering, optional visual review, D1/R2 artifacts. |
| Application autofill | **Current but preparation-only** | Extension sends live fields to `application.match` and fills returned values. |
| Approval and submission | **Human-only / not tracked automatically** | The user submits outside ApplyGo and manually marks Applied. No submission receipt or idempotent execution checkpoint exists. |
| Application monitoring, interviews, offers, accepted job | **Planned** | Product/roadmap documents describe these goals, but the runtime and schema do not implement them. |

## Architectural gaps that affect orchestration

1. There is no LangGraph or durable workflow-run object. The UI invokes independent, resumable
   endpoints, while D1 row state supplies the checkpoints.
2. There is no scheduler for company discovery or board scanning. The daily scan guard prevents
   redundant work but does not initiate work.
3. A removed or expired ATS posting is not given a closed state; the database retains it and the
   scan updates only current counts and newly observed data.
4. `fit_status` combines model verdicts and human/application state. Moving to `interested` or
   `applied` retains scores but hides the underlying verdict in the status field.
5. Generated-document existence stands in for document lifecycle state. There is no explicit
   human approval or ready-to-apply record.
6. Manual `applied_at` is not linked to a submission receipt and cannot distinguish submitted,
   acknowledged, rejected, withdrawn, interviewing, offered, or accepted outcomes.
7. Profile changes do not automatically invalidate prior company proposals or assessments.
   Future discovery reads the new profile, and the explicit Reassess action requeues scored jobs.
