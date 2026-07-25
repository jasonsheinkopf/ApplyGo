# ApplyGo

ApplyGo is an AI-native, human-supervised job-search and application platform designed for a hiring process that has already been transformed by artificial intelligence.

Candidates increasingly use AI to identify opportunities, understand job requirements, improve résumés, draft application materials, and prepare for interviews. Employers increasingly use software and AI to search, filter, rank, summarize, and evaluate candidates. ApplyGo is designed around the reality that AI now operates on both sides of the hiring process.

The objective is not to automate every decision or remove the candidate from the process. The objective is to use AI wherever it can reliably reduce repetitive work, improve consistency, and surface better information, while reserving consequential judgments, approvals, and personal decisions for the human user.

ApplyGo should allow a candidate to spend less time repeatedly copying information, reformatting documents, searching across fragmented job sites, and adapting the same material for different employers. That time can instead be spent on decisions and activities that require human judgment: deciding which opportunities matter, confirming what is truthful, choosing how to present a career, preparing for conversations, building skills, and determining whether a role is genuinely desirable.

This repository contains the deliberate, production-oriented implementation of ApplyGo. The earlier rapid prototype is preserved separately in `jasonsheinkopf/ApplyGo-prototype`.

---

## Why ApplyGo exists

The job-application process is no longer purely human-to-human.

A modern candidate may be evaluated by keyword filters, ranking systems, résumé parsers, automated screening workflows, recruiter copilots, and AI-assisted review. At the same time, candidates have access to models capable of interpreting job descriptions, restructuring professional evidence, generating application materials, and automating repetitive interactions.

This shift is not temporary. The practical question is no longer whether AI should participate in the process, but how it should be used responsibly, effectively, and transparently.

ApplyGo is based on several principles:

1. **AI should perform repetitive work when it can do so reliably.** Re-entering the same information, comparing large numbers of listings, tracking application state, and producing first-pass document adaptations are poor uses of human attention.
2. **Humans should retain control over consequential decisions.** The user must remain responsible for truthfulness, personal preferences, sensitive disclosures, final submissions, and communication sent in their name.
3. **AI-generated output must be measurable.** A system that produces persuasive text but cannot be evaluated, traced, or corrected is not dependable enough for high-impact use.
4. **The system must understand the candidate, not merely rewrite keywords.** Recommendations and generated materials should be grounded in structured evidence about the user’s actual history, skills, goals, and constraints.
5. **The product should optimize the whole workflow.** Job discovery, fit analysis, résumé preparation, application execution, communications, and outcome tracking should share persistent context instead of operating as disconnected tools.
6. **Cost, quality, latency, and privacy are architectural concerns.** Different tasks may justify different models, providers, and execution environments.

ApplyGo therefore aims to be more than a résumé generator or job scraper. It is intended to become a durable decision-support and workflow platform for an AI-mediated hiring environment.

---

## Project history

### Phase 0: Rapid prototype

The first ApplyGo implementation was created through rapid AI-assisted development using Claude and ChatGPT.

The prototype was intentionally exploratory. Its purpose was to discover what the product should do, what users need to see, and where autonomous execution becomes unreliable.

It explored questions such as:

- Which parts of a job search are genuinely useful to automate?
- Which operations require explicit human approval?
- What information must remain visible while a workflow is running?
- How should generated documents and application state be presented?
- Where do browser agents and language models fail?
- What persistent data is needed across jobs, documents, and applications?

The prototype produced a partially working application and revealed important structural weaknesses:

- loosely defined workflows
- unclear application state
- insufficient visibility into system activity
- fragile execution
- limited failure recovery
- insufficient evaluation
- unclear prompt and model behavior
- incomplete separation between deterministic logic and AI judgment
- architecture that would require substantial rework before dependable use

The prototype is treated as a successful requirements-discovery exercise rather than the production foundation. It remains preserved in a separate repository so its ideas, failures, and interface concepts can inform the new system without constraining the architecture.

---

## Product philosophy

### AI where it is useful; human judgment where it is necessary

ApplyGo should automate analysis, organization, drafting, comparison, monitoring, and repetitive execution where those tasks can be performed reliably.

It should not silently make personal or consequential decisions.

The intended division of responsibility is:

```text
AI responsibilities
- organize candidate information
- identify missing information
- search and normalize jobs
- compare jobs with candidate preferences
- explain fit and uncertainty
- prepare tailored documents
- prefill repetitive application fields
- monitor application state and correspondence
- identify actions requiring attention

Human responsibilities
- verify truthfulness
- define and revise preferences
- resolve ambiguous career claims
- approve application materials
- answer sensitive questions
- make salary and relocation decisions
- approve external communications
- authorize submission
- choose whether a job is worth pursuing
```

The objective is not maximum autonomy. It is maximum useful assistance under clear human control.

### Deterministic workflows with agentic components

ApplyGo should not be implemented as one unrestricted agent improvising every action.

Most of the system should use explicit workflows, schemas, permissions, and state transitions. Language models and agents should be used where interpretation, judgment, planning, or recovery adds measurable value.

Deterministic responsibilities include:

- database updates
- duplicate detection
- hard eligibility rules
- document versioning
- state transitions
- required approval checks
- retry limits
- preventing duplicate submissions
- access control
- audit records

Model-powered or agentic responsibilities include:

- interpreting ambiguous career experience
- asking useful follow-up questions
- identifying evidence relevant to a role
- evaluating job fit
- adapting application materials
- interpreting unstructured employer communication
- navigating unfamiliar forms
- recovering from unexpected browser states

### Human supervision for consequential actions

Human approval should be required before actions such as:

- submitting an application
- agreeing to legal declarations
- answering sensitive demographic questions
- entering salary expectations
- sending recruiter messages
- creating third-party accounts
- uploading unreviewed documents
- withdrawing an application

The system should clearly display what it plans to do, what data it will use, and what will be sent externally.

### Evidence before persuasion

ApplyGo must not invent or embellish candidate experience merely because a statement would improve perceived fit.

Candidate claims should be linked to source evidence wherever practical, including:

- uploaded résumés
- user-provided descriptions
- structured interview answers
- portfolios
- project records
- previously approved profile facts

Generated résumés and application answers should distinguish among:

- verified facts
- user-confirmed interpretations
- inferred but reviewable conclusions
- missing information

### Model-agnostic architecture

The product should not depend on one model vendor.

Different tasks may use different local or hosted models based on measured quality, latency, privacy, availability, context requirements, and cost.

Potential execution options include:

- hosted OpenAI models
- hosted Anthropic models
- local models served through Ollama
- other providers added behind a common interface

Provider-specific logic should remain isolated behind a model gateway.

### Evaluation from the beginning

Evaluation is part of the architecture, not a final testing step.

Each AI-powered capability should have:

- a clearly defined task
- versioned inputs and prompts
- structured outputs where appropriate
- representative evaluation cases
- objective and semantic metrics
- failure cases
- latency measurements
- token and monetary cost measurements
- a documented model-selection policy

### Documentation as part of completion

A feature is not complete merely because it works once.

Completion should include:

- implementation
- tests
- updated architecture documentation
- relevant decision records
- evaluation results
- known limitations
- failure analysis
- operational considerations

---

## Development and decision-making model

ApplyGo will be developed through an AI-assisted engineering workflow.

AI systems may be used to perform research, compare technologies, propose designs, draft implementations, generate tests, analyze experiments, and prepare documentation. Architectural decisions remain evidence-driven and must be reviewed against explicit product requirements.

The intended workflow is:

```text
Define a product or engineering problem
        ↓
Establish requirements and decision criteria
        ↓
Research realistic alternatives
        ↓
Prototype or benchmark when necessary
        ↓
Review evidence and tradeoffs
        ↓
Record the decision
        ↓
Implement the selected approach
        ↓
Evaluate quality, reliability, latency, and cost
        ↓
Update documentation and operating guidance
```

AI involvement should be transparent. The project should demonstrate disciplined use and supervision of AI-assisted engineering rather than conceal it.

---

## Documentation strategy

The repository will use Markdown documentation published with Material for MkDocs.

The README serves as the high-level product and architecture overview. As the project grows, detailed material should move into focused documentation areas:

```text
docs/
├── product/
├── roadmap/
├── architecture/
├── decisions/
├── research/
├── experiments/
├── stages/
├── evaluation/
├── operations/
├── security/
└── failures/
```

### Architecture Decision Records

Important technical choices should use concise Architecture Decision Records.

Each decision should record:

- context
- requirements
- alternatives considered
- evaluation criteria
- selected approach
- rationale
- consequences
- validation plan
- conditions that would justify reconsideration

Research reports and decisions should remain separate. Research explains the available options. Decision records explain what was selected and why.

### Experiment records

Experiments should follow a consistent structure:

1. Question
2. Hypothesis
3. Method
4. Dataset
5. Metrics
6. Results
7. Decision
8. Limitations
9. Next action

### Failure records

Important failures should be documented when they reveal a reusable engineering lesson.

A failure record may include:

- observed behavior
- expected behavior
- root cause
- user impact
- detection method
- corrective action
- preventive controls

---

## High-level system vision

ApplyGo should ultimately operate as a hosted, device-independent application.

A user should be able to interact with the same persistent system from a phone, laptop, tablet, or desktop.

```text
Phone / Laptop / Tablet
          ↓
Hosted frontend
          ↓
Application API
          ↓
Persistent database + object storage + background jobs
          ↓
Workflow orchestration
          ↓
Model gateway
    ├── Hosted model providers
    └── Authenticated local model worker
          ↓
Tracing, evaluation, monitoring, and cost analysis
```

A local computer may optionally provide local inference through Ollama, but it should operate as an authenticated worker rather than being directly exposed to the public internet.

When a local worker is unavailable, the system should follow an explicit fallback policy:

- route to an approved hosted model
- wait until local execution is available
- fail clearly when a task is designated local-only

---

## Data and persistent state

ApplyGo must track information over long periods. A job may be discovered today, saved for a week, applied to later, and receive a response a month afterward.

Persistent product data should include:

- users
- candidate profiles
- career goals and preferences
- candidate evidence and claims
- uploaded source documents
- résumé versions
- job-search strategies
- discovered jobs
- normalized job records
- job evaluations
- generated documents
- applications
- approval records
- application history
- correspondence and responses
- tasks and notifications
- workflow runs
- model configurations
- evaluation results
- cost and usage records

A relational database such as PostgreSQL is the expected production default because the system is intended to support multiple users, multiple devices, concurrent workflows, and durable state.

Large files such as résumés, generated PDFs, screenshots, and browser artifacts should be stored in object storage, with metadata and ownership recorded in the database.

Application state and workflow execution state should be treated separately.

For example:

- the fact that an application is in an `INTERVIEWING` state belongs in the product database
- the fact that a workflow is paused before a human-review node belongs in workflow checkpoint storage

---

## Workflow orchestration

ApplyGo requires explicit state, long-running workflows, durable checkpoints, interruption for human review, resumable execution, and traceable node-level behavior.

LangGraph is a leading candidate for workflow orchestration because it is designed for these requirements. It is not permanently selected until the architecture phase compares it against realistic alternatives and records the decision.

The default principle is that workflow graphs act as the primary orchestrators. The system should not begin with a large hierarchy of loosely defined named agents.

Capabilities may later become agents or subgraphs when open-ended planning, independent tool use, or specialized recovery is justified by measured performance.

---

## Model gateway and routing

Business logic should not call a specific model provider directly.

AI-powered tasks should use a common request interface that describes the capability required.

Conceptually:

```text
Task request
- task type
- required capabilities
- output schema
- privacy policy
- quality tier
- latency requirement
- fallback policy
```

The model gateway should select a model configuration using factors such as:

- measured task quality
- factuality
- schema reliability
- tool-use capability
- context requirements
- latency
- provider availability
- privacy
- token usage
- monetary cost
- local compute cost

Routing decisions should eventually be based on recorded evaluation results rather than intuition.

---

## Evaluation and observability

MLflow is a leading candidate for experiment tracking, tracing, prompt and model comparison, evaluation datasets, model-based scoring, latency, token use, and cost analysis.

LangSmith and other realistic alternatives should also be researched where relevant. The project does not need to test every tool; it should compare the strongest options when the decision materially affects reliability, observability, cost, or maintainability.

### Evaluation datasets

Evaluation should use a combination of:

- manually authored canonical cases
- synthetic cases
- difficult and adversarial cases
- real consented user cases

Synthetic datasets may be generated by strong models, but generated answers should not automatically be treated as ground truth.

A stronger process is:

```text
Generate diverse synthetic cases
        ↓
Create expected facts and hidden reference profiles
        ↓
Manually audit a meaningful sample
        ↓
Run candidate systems
        ↓
Score with deterministic metrics, independent judges, and human review
```

### Deterministic scoring

Examples include:

- schema validity
- required-field presence
- exact date accuracy
- duplicate rate
- unsupported claim count
- evidence-reference validity
- state-transition correctness
- retry behavior
- submission idempotency
- latency
- tokens
- monetary cost

### Model-based scoring

Examples include:

- usefulness of follow-up questions
- completeness of a candidate summary
- quality of résumé recommendations
- semantic fit between a candidate and a job
- clarity and relevance of generated text
- quality of a multi-step execution trace

### Human evaluation

Examples include:

- factual corrections
- accepted and rejected recommendations
- usefulness of questions
- candidate effort
- trust in the generated profile
- willingness to submit generated materials
- agreement with job-fit rankings

Model judges should be calibrated against human decisions rather than accepted uncritically.

### Production monitoring

Production monitoring should distinguish between model quality and system reliability.

Operational metrics may include:

- workflow completion rate
- failure rate by node
- retry frequency
- browser automation failure category
- human intervention rate
- average time to complete a workflow
- model latency
- queue delay
- provider errors
- cost per workflow

---

## Cost tracking

Every model-powered operation should record cost-related metadata where available:

- provider
- model
- task type
- prompt version
- input tokens
- output tokens
- cached tokens
- latency
- estimated monetary cost
- local or hosted execution
- workflow and user identifiers

Useful aggregate metrics include:

- cost per candidate profile
- cost per job discovered
- cost per job evaluated
- cost per tailored résumé
- cost per completed application
- cost per successful outcome
- quality versus cost by model
- latency versus cost by model

Local models should not be described as free. Their accounting may include compute time, power consumption, hardware utilization, and operational availability even when no per-token invoice exists.

---

## Security, privacy, and trust

ApplyGo may handle highly sensitive information, including employment history, contact details, compensation preferences, application credentials, correspondence, and demographic disclosures.

The architecture must account for:

- authentication
- authorization
- encryption in transit and at rest
- secret management
- least-privilege access
- audit history
- data retention
- deletion and export
- third-party provider boundaries
- prompt-injection resistance
- safe browser automation
- consent for email and account access

Uploaded résumés, generated documents, browser screenshots, and email content must be treated as private user data.

The system should make clear:

- which model or provider receives data
- what information is sent
- why it is required
- whether the action can be performed locally
- what external action will occur after approval

---

## Product roadmap

The roadmap is organized into phases. Each phase should produce a usable capability, an evaluation method, documentation, and an explicit definition of done.

### Phase 0 — Rapid prototype

**Status:** Preserved separately.

**Purpose:** Discover useful features, interface expectations, workflow risks, and architectural weaknesses through rapid experimentation.

**Outputs:**

- initial product concept
- early user-interface ideas
- partial workflow implementation
- evidence of failure modes
- requirements for the production system

---

### Phase 1 — Architecture, evaluation, and operating foundation

**Purpose:** Define how the system will be engineered before major product implementation begins.

This phase should establish:

- product requirements
- nonfunctional requirements
- system boundaries
- data ownership
- workflow and state model
- human-approval policy
- model gateway design
- evaluation framework
- observability and tracing strategy
- cost accounting
- security and privacy requirements
- documentation conventions
- deployment principles

Research topics may include:

- workflow orchestration frameworks
- PostgreSQL hosting and migrations
- object storage
- background job execution
- authentication
- model-provider abstraction
- local model workers
- MLflow, LangSmith, and observability alternatives
- browser automation
- email integration
- frontend and backend architecture

**Definition of done:**

- high-level architecture documented
- critical decisions recorded
- initial data model proposed
- evaluation strategy defined
- cost schema defined
- security assumptions documented
- phase interfaces and dependencies identified

---

### Phase 2 — Product shell and frontend foundation

**Purpose:** Build the persistent interface through which users understand and control the system.

The frontend should be treated as a core product capability, not a cosmetic layer added after backend development.

It should establish:

- responsive application shell
- navigation
- authentication flow
- persistent user sessions
- system status visibility
- workflow progress displays
- review and approval interfaces
- document previews
- error and recovery states
- settings and preferences
- accessible design system

The interface should make AI activity understandable. Users should be able to see:

- what the system is doing
- what information it is using
- why a recommendation was made
- what remains uncertain
- what requires approval
- what happened after an action

**Definition of done:**

- usable responsive interface
- core navigation and states implemented
- mocked end-to-end workflow demonstrated
- human-review interactions tested
- accessibility and usability issues documented

---

### Phase 3 — Candidate intelligence and résumé foundation

**Purpose:** Build a structured, evidence-based understanding of the candidate.

The system should accept:

- existing résumés
- free-form career descriptions
- project information
- education and certifications
- work preferences
- location constraints
- compensation expectations
- portfolio information
- conversational answers

It should then:

1. extract structured facts
2. identify uncertainty and missing information
3. conduct a focused conversational interview
4. build a candidate profile
5. link important claims to evidence
6. infer target-role categories
7. generate and maintain job-search preferences
8. create a strong baseline résumé
9. allow the user to review and correct every important conclusion

The profile should become the source of truth for downstream workflows.

Potential structured areas include:

- roles and employers
- dates and chronology
- responsibilities
- technical skills
- domain experience
- projects
- accomplishments
- quantified outcomes
- education
- certifications
- location and work authorization
- desired roles
- disallowed roles
- compensation range
- remote, hybrid, and relocation preferences

The résumé capability should produce professional, ATS-compatible documents grounded only in approved evidence. It should support versioning and explain why content was included, omitted, or rewritten.

**Evaluation questions:**

- Did the system extract facts correctly?
- Did it identify meaningful gaps?
- Were follow-up questions useful and nonredundant?
- Were unsupported claims avoided?
- Did users accept the resulting profile?
- Did the résumé accurately represent the candidate?
- Was the document structurally compatible with common parsers?

**Definition of done:**

- candidate profile can be created, reviewed, edited, and versioned
- claims can be traced to evidence
- preferences can be changed conversationally and through structured controls
- baseline résumé can be generated and exported
- evaluation dataset and baseline results are recorded

---

### Phase 4 — Job discovery and normalization

**Purpose:** Find relevant opportunities and convert fragmented listings into persistent, comparable job records.

The system should support:

- scheduled discovery
- user-initiated search
- company career pages
- selected job boards
- manually supplied URLs
- duplicate detection
- listing updates
- expiration detection
- source attribution

Job records should normalize information such as:

- employer
- title
- location
- compensation
- employment type
- required skills
- preferred skills
- experience expectations
- work authorization
- remote or hybrid policy
- travel requirements
- application deadline
- source URL
- original posting text
- discovery timestamp

Discovery should remain separate from evaluation. A job can be stored before the system decides whether it is a good match.

**Evaluation questions:**

- What proportion of relevant jobs are found?
- How many duplicates are created?
- How accurately are fields normalized?
- How often are stale jobs retained?
- What is the cost per useful discovery?

**Definition of done:**

- jobs can be discovered, normalized, deduplicated, stored, filtered, and revisited
- source evidence is retained
- scheduled discovery is observable and recoverable

---

### Phase 5 — Job matching and preference management

**Purpose:** Evaluate each opportunity against the candidate’s evidence, goals, and constraints.

The system should not return only a single opaque score.

A useful evaluation may include:

- hard eligibility checks
- role alignment
- skill alignment
- domain alignment
- seniority alignment
- location compatibility
- compensation compatibility
- work-authorization compatibility
- preference alignment
- missing qualifications
- transferable strengths
- uncertainty
- recommended next action

The user should be able to:

- inspect the reasoning
- correct assumptions
- change preferences
- provide conversational feedback
- save or reject jobs
- filter and search the database
- teach the system from accepted and rejected recommendations

Preference changes should update the structured profile rather than exist only as transient chat messages.

**Evaluation questions:**

- Do rankings agree with human judgment?
- Are hard constraints enforced correctly?
- Are explanations grounded in evidence?
- Does user feedback improve later recommendations?
- Can the system distinguish missing information from genuine mismatch?

**Definition of done:**

- jobs receive evidence-grounded evaluations
- users can inspect and revise reasoning
- preferences update persistently
- ranking quality is measured against human labels

---

### Phase 6 — Tailored application materials

**Purpose:** Generate truthful, job-specific materials after a user chooses to pursue an opportunity.

Outputs may include:

- tailored résumé
- cover letter
- short application answers
- skills summaries
- project selections
- recruiter outreach drafts
- interview-preparation notes

The system should explain:

- which job requirements influenced the output
- which candidate evidence supports each major claim
- what changed from the baseline résumé
- what information remains uncertain
- what requires user review

Documents should be versioned and reproducible from their inputs, prompt version, model configuration, and selected evidence.

**Evaluation questions:**

- Are all claims supported?
- Is the most relevant evidence selected?
- Does the résumé remain readable and ATS-compatible?
- Does tailoring improve relevance without keyword stuffing?
- How much human editing is required?
- What is the cost per approved document set?

**Definition of done:**

- application materials can be generated, compared, reviewed, edited, approved, and exported
- all major claims are traceable
- document-generation quality and cost are measured

---

### Phase 7 — Application execution

**Purpose:** Reduce repetitive form-filling while preserving human control over submission.

The system may use browser automation to:

- open application pages
- identify form structure
- populate known fields
- upload approved documents
- identify unanswered questions
- pause for sensitive or ambiguous decisions
- resume after user input
- capture confirmation evidence

Application execution is expected to be one of the most difficult phases because employer systems vary widely and may contain:

- dynamically generated forms
- account creation
- email verification
- multifactor authentication
- CAPTCHA
- custom questionnaires
- required demographic forms
- unstable selectors
- anti-automation controls

The architecture must assume that not every application can or should be completed autonomously.

Possible execution modes include:

1. **Assisted mode:** Prepare documents and answers while the user completes the form.
2. **Copilot mode:** Populate the form and pause for review or unresolved questions.
3. **Automated mode:** Complete approved low-risk steps and stop before final submission.

The default should be conservative. Final submission requires explicit user authorization.

**Evaluation questions:**

- What percentage of fields are populated correctly?
- How frequently is human intervention required?
- Are sensitive questions handled correctly?
- Can interrupted workflows resume safely?
- Are duplicate submissions prevented?
- Is confirmation evidence captured?

**Definition of done:**

- supported applications can be prepared safely
- uncertain actions pause clearly
- workflows resume after intervention
- duplicate submissions are prevented
- final submission remains human-authorized

---

### Phase 8 — Communications and lifecycle management

**Purpose:** Track what happens after submission and help the user respond appropriately.

With explicit permission, the system may connect to email to:

- identify acknowledgements
- detect interview invitations
- detect rejections
- detect requests for additional information
- associate messages with applications
- update application status
- extract deadlines and scheduling requests
- notify the user when action is required
- draft responses for approval

The system should not send external messages without an explicit policy and appropriate approval.

The application lifecycle may include states such as:

```text
DISCOVERED
SAVED
REJECTED_BY_USER
PREPARING
READY_FOR_REVIEW
APPROVED
SUBMITTING
SUBMITTED
ACKNOWLEDGED
SCREENING
INTERVIEWING
OFFER
REJECTED
WITHDRAWN
CLOSED
```

Every transition should preserve timestamped history and source evidence.

**Evaluation questions:**

- Are messages associated with the correct application?
- Are status changes accurate?
- Are deadlines extracted correctly?
- Are important messages surfaced promptly?
- Are drafts appropriate and grounded in context?

**Definition of done:**

- application correspondence can be associated, summarized, and surfaced
- state transitions are auditable
- notifications are useful rather than noisy
- message drafts require appropriate approval

---

### Phase 9 — Continuous improvement and production hardening

**Purpose:** Use real outcomes and operating evidence to improve the system.

Potential feedback signals include:

- jobs saved or rejected
- ranking corrections
- résumé edits
- generated materials approved or discarded
- applications completed or abandoned
- screening responses
- interview invitations
- rejection timing
- offers
- workflow failures
- human interventions
- cost and latency

These signals should be used carefully. A hiring outcome is affected by many external variables and should not automatically be treated as a clean label for model quality.

This phase should also address:

- scalability
- backups
- disaster recovery
- rate limits
- provider outages
- security review
- privacy controls
- data deletion and export
- model regression detection
- prompt versioning
- release management
- operational dashboards

**Definition of done:**

- core workflows have production monitoring
- regressions can be detected
- costs can be explained
- user data can be exported or deleted
- failure recovery is documented and tested

---

## Cross-phase engineering requirements

Every phase should address the following concerns rather than postponing them until the end.

### Reliability

- idempotent operations where required
- explicit retry policies
- timeouts
- resumable workflows
- clear failure states
- duplicate prevention
- transactional updates where appropriate

### Explainability

The user should be able to understand:

- why a job was recommended
- why a résumé was changed
- what evidence supports a claim
- what the system is uncertain about
- why a workflow paused
- what external action is about to occur

### Reproducibility

Model-powered results should record enough metadata to reproduce or analyze them:

- model provider and version
- prompt or template version
- input references
- output schema version
- retrieval context
- configuration
- timestamp
- evaluation results

### Portability

Core business logic should remain separable from:

- frontend framework
- model vendor
- deployment provider
- browser automation provider
- observability platform

### Accessibility

The product should support clear language, keyboard use, responsive layouts, visible status, and accessible review workflows.

---

## Initial technology candidates

The following technologies are candidates, not final commitments:

| Concern | Leading candidate | Notes |
|---|---|---|
| Documentation | Material for MkDocs | Markdown-first technical documentation |
| Workflow orchestration | LangGraph | Durable, interruptible AI workflows |
| Product database | PostgreSQL | Relational persistent application state |
| Experiment tracking and tracing | MLflow | Evaluation, traces, latency, tokens, and cost |
| Local inference | Ollama | Optional private or low-cost local execution |
| Browser automation | Playwright | Deterministic automation with agentic recovery where needed |
| Object storage | To be evaluated | Résumés, PDFs, screenshots, and artifacts |
| Frontend | To be evaluated | Responsive, review-oriented product interface |
| Backend API | To be evaluated | Typed application and workflow interfaces |
| Background execution | To be evaluated | Durable scheduled and asynchronous work |
| Authentication | To be evaluated | Secure multi-device access |

No technology should be selected solely because it is fashionable. Important choices should follow from requirements, tradeoffs, focused experiments, and operational constraints.

---

## Definition of a production-ready capability

A capability should not be called production-ready unless it has, where applicable:

- explicit requirements
- typed inputs and outputs
- persistent state
- authentication and authorization
- error handling
- retries and timeouts
- idempotency
- tests
- evaluation cases
- tracing
- monitoring
- cost measurement
- human-review policy
- security and privacy review
- documentation
- known limitations
- rollback or recovery strategy

Production-ready does not mean perfect. It means the system’s behavior, risks, and operating boundaries are understood and managed.

---

## Current status

The production repository is currently in the planning and architecture stage.

The immediate priority is not feature implementation. It is to establish a coherent product architecture, evaluation strategy, documentation structure, cost model, security posture, and phased operating plan before building the major workflows.

The rapid prototype remains available as a source of requirements and lessons, but the production implementation will be built deliberately from a clean foundation.
