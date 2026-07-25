# ApplyGo

ApplyGo is a production-oriented, human-supervised job-search and application platform designed to help users understand their professional profile, identify suitable jobs, prepare tailored application materials, manage applications, and track outcomes over time.

The product itself matters, but ApplyGo has a second and equally important purpose: it is an agent-engineering capstone project. It is intended to provide practical experience designing, evaluating, documenting, and operating modern AI systems that combine deterministic workflows, language models, local and hosted inference, persistent state, human approval, observability, cost tracking, and production deployment.

This repository is the clean, production-oriented implementation of ApplyGo. The earlier rapid prototype is preserved separately in `jasonsheinkopf/ApplyGo-prototype`.

---

## Why this project exists

There are already products that search for jobs, rewrite résumés, generate cover letters, or automate applications. ApplyGo is not being built because none of those products exist.

It is being built for four reasons:

1. **To solve a real problem.** The system should become genuinely useful for managing a job search beginning in late 2026.
2. **To learn production agent engineering.** The project is a platform for learning orchestration, evaluation, observability, model routing, human-in-the-loop control, cost management, and deployment.
3. **To create a reusable architecture.** The long-term goal is to establish a repeatable method and technical foundation that can seed future agentic applications.
4. **To create interview evidence.** Every important architectural decision, experiment, tradeoff, failure, and measured result should be understandable and defensible in a technical interview.

The objective is not merely to produce a functioning website. The objective is to produce a system whose behavior can be explained, measured, improved, and trusted.

---

## Project history

### Phase 0: Rapid prototype

The first ApplyGo implementation was created through approximately one week of rapid AI-assisted development using Claude and ChatGPT.

The prototype was intentionally exploratory. Its purpose was to answer questions such as:

- What can current AI systems do autonomously?
- Which job-search and application features are actually useful?
- What should the interface expose to the user?
- Which operations require human approval?
- Where do autonomous systems fail?
- What state and progress information must be visible?

The prototype produced a partially working application, but it also revealed structural weaknesses:

- loosely defined workflows
- unclear application state
- insufficient visibility into what the system was doing
- fragile execution
- limited failure recovery
- insufficient evaluation
- unclear model and prompt behavior
- incomplete separation between deterministic software and AI decisions
- architecture that would require significant rework before becoming dependable

The prototype is therefore treated as a successful requirements-discovery exercise rather than as the production foundation.

It remains preserved in a separate repository so the transition from rapid exploration to deliberate engineering is visible.

---

## Core project philosophy

### Product first, but evidence-driven

ApplyGo should become a useful product, but major technical choices should be based on explicit requirements and evidence rather than novelty or framework popularity.

### Deterministic workflows with agentic components

The system should not be one unrestricted agent that improvises every action.

Most of the application should be implemented as explicit workflows and state transitions. Language models or agents should be used where interpretation, judgment, planning, or recovery is genuinely valuable.

Examples of deterministic responsibilities include:

- database updates
- duplicate detection
- hard eligibility rules
- document versioning
- state transitions
- approval requirements
- retry limits
- preventing duplicate submissions

Examples of model-powered or agentic responsibilities include:

- interpreting ambiguous career experience
- asking useful follow-up questions
- evaluating job fit
- selecting relevant evidence
- adapting application materials
- navigating unfamiliar forms
- recovering from unexpected browser states

### Human supervision for consequential actions

ApplyGo should be autonomous in analysis and preparation but conservative in external actions.

Human approval should be required before actions such as:

- submitting an application
- agreeing to declarations
- answering sensitive demographic questions
- entering salary expectations
- sending recruiter messages
- creating third-party accounts
- uploading unreviewed documents

### Model-agnostic architecture

The application should not depend on one model vendor.

The system should support multiple hosted and local model providers through a common interface. Different tasks may use different models based on measured quality, latency, privacy, availability, and cost.

Potential providers include:

- hosted Anthropic models
- hosted OpenAI models
- local models served through Ollama
- additional providers added later

### Evaluation from the beginning

Evaluation is not a final testing step. It is part of the architecture.

Each model-powered capability should have:

- a clearly defined task
- versioned inputs
- expected behavior
- objective and semantic metrics
- representative test cases
- failure cases
- cost and latency measurements
- a documented production-selection policy

### Documentation as part of completion

A feature is not complete when only the code works.

It should also have:

- updated architecture documentation
- relevant decision records
- evaluation results
- known limitations
- failure analysis
- an interview-ready explanation

---

## Operating model

The project will be developed using an AI-assisted technical-lead workflow.

The project owner acts as the architect and technical lead. AI systems may perform research, propose designs, implement code, generate tests, analyze results, and draft documentation.

The owner remains responsible for:

- defining requirements
- deciding evaluation criteria
- reviewing evidence
- approving architecture
- challenging recommendations
- selecting tools and models
- validating implementation behavior
- understanding tradeoffs
- explaining the full system

The intended workflow is:

```text
Define a problem or research question
        ↓
Assign focused research or implementation work
        ↓
Receive a structured recommendation or result
        ↓
Challenge assumptions and identify uncertainties
        ↓
Run a prototype, comparison, or experiment when needed
        ↓
Review evidence
        ↓
Make and document a decision
        ↓
Implement and evaluate
        ↓
Update architecture, roadmap, and interview notes
```

AI usage should be transparent. The project should demonstrate effective supervision of AI systems, not pretend that AI was not involved.

---

## Documentation strategy

The repository will eventually use Markdown documentation published with Material for MkDocs.

The initial README serves as the single high-level source of truth. As the project grows, its content will be divided into focused documentation areas such as:

```text
docs/
├── roadmap/
├── architecture/
├── decisions/
├── research/
├── experiments/
├── stages/
├── operations/
├── failures/
└── interview/
```

Important technical choices should use short Architecture Decision Records.

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
    └── Authenticated local Ollama worker
          ↓
Tracing, evaluation, monitoring, and cost analysis
```

A local computer may optionally serve local models through Ollama, but it should act as an authenticated worker rather than being directly exposed to the public internet.

If the local worker is unavailable, the system should follow an explicit fallback policy:

- route to an approved hosted model
- wait until the local worker becomes available
- fail clearly when a task is designated local-only

---

## Data and persistent state

ApplyGo must track information over long periods. A job may be discovered today, saved for a week, applied to later, and receive a response a month afterward.

Persistent product data should include:

- users
- candidate profiles
- candidate evidence and claims
- uploaded documents
- job-search strategies
- discovered jobs
- job evaluations
- generated documents
- applications
- approval records
- application history
- correspondence and responses
- workflow runs
- model configurations
- evaluation results

A relational database such as PostgreSQL is the expected production default because the system is intended to support multiple users, multiple devices, concurrent workflows, and durable state.

Large files such as résumés, generated PDFs, screenshots, and browser artifacts should be stored in object storage, with metadata and ownership recorded in the database.

Application state and workflow execution state should be treated separately.

For example:

- the fact that a job application is in the `INTERVIEWING` state belongs in the product database
- the fact that a particular workflow is paused before a review node belongs in workflow checkpoint storage

---

## Workflow orchestration

LangGraph is a leading candidate for workflow orchestration because ApplyGo requires:

- explicit state
- long-running workflows
- durable checkpoints
- interruption for human review
- resumable execution
- traceable node-level behavior

It is not yet considered permanently selected merely because it is currently favored. The architecture phase should compare it against reasonable alternatives and document the decision.

The default design principle is that the workflow graph itself acts as the orchestrator. The project should not begin with an unrestricted hierarchy of many named agents.

Capabilities can later become agents or subgraphs when open-ended planning or tool use is justified by measured performance.

---

## Model gateway and routing

Business logic should not call a specific model provider directly.

Instead, model-powered tasks should use a common request interface that describes the capability needed.

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

The routing system should eventually be based on recorded evaluation results rather than intuition.

---

## Evaluation and observability

MLflow is a leading candidate for experiment tracking, tracing, prompt and model comparison, evaluation datasets, model-based scoring, latency, token use, and cost analysis.

LangSmith and other alternatives should also be researched and, where useful, evaluated on focused workflows.

The project does not need to test every available tool. It should research the strongest realistic alternatives and perform direct comparisons where the decision is important or educational.

A practical strategy may be to use different tools in different focused experiments when that provides genuine learning without duplicating the entire platform.

### Evaluation datasets

Evaluation should use a combination of:

- manually authored canonical cases
- synthetic cases
- difficult and adversarial cases
- real consented user cases

Initially, the real users will include the project owner and the project owner’s wife. This provides an early test of whether the system generalizes beyond one candidate profile.

Synthetic datasets may be generated by strong models, but a strong model’s answer must not automatically be treated as unquestionable ground truth.

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

### Types of scoring

#### Deterministic scoring

Examples include:

- schema validity
- required-field presence
- exact date accuracy
- duplicate rate
- unsupported entity count
- evidence-reference validity
- state-transition correctness
- retry behavior
- latency
- tokens
- cost

#### Model-based scoring

Examples include:

- usefulness of follow-up questions
- completeness of a candidate summary
- quality of résumé advice
- semantic fit between a candidate and a job
- clarity and relevance of generated text
- quality of a multi-step execution trace

#### Human evaluation

Examples include:

- factual corrections
- accepted and rejected recommendations
- usefulness of questions
- candidate effort
- trust in the generated profile
- willingness to submit generated application materials

Model judges should be calibrated against human decisions rather than treated as the final authority.

### Cost tracking

Wherever technically possible, each model-powered run should record:

- provider
- model
- prompt version
- tokens
- latency
- retries
- monetary cost
- local execution duration
- quality scores
- human corrections

The production model should not necessarily be the model with the highest raw score. A model is eligible only if it meets the required quality and safety thresholds. Among eligible configurations, the system may select the lowest-cost or fastest option that satisfies the task requirements.

---

## Product roadmap

The current roadmap is intentionally high level. Each phase will later receive its own requirements, workflow, metrics, risks, experiments, and definition of done.

### Phase 0: Rapid prototype — complete

Purpose:

- explore the product space quickly
- identify useful features
- expose failure modes
- learn what the user must be able to see and control

Output:

- preserved prototype repository
- early UX lessons
- initial failure inventory
- baseline for comparison

### Phase 1: Architecture, research, and engineering plan

Purpose:

- define how the project will be designed, evaluated, documented, and operated before broad implementation begins

Expected work:

- formalize product goals and non-goals
- define major user journeys
- define stage boundaries
- define state and ownership models
- research workflow orchestration options
- research database and object-storage options
- research local and hosted model integration
- research evaluation and observability platforms
- define model-provider abstraction
- define evaluation methodology
- define cost tracking
- define human approval policy
- define security and privacy principles
- establish documentation conventions
- establish Architecture Decision Records
- establish experiment templates
- establish definitions of done
- design the initial system architecture

Definition of done:

- a documented architecture is approved
- major technology choices have explicit rationale
- unresolved questions are visible
- the first implementation phase has clear inputs, outputs, metrics, and acceptance criteria

### Phase 2: Frontend and interaction foundation

Purpose:

- create a clear interface that exposes system state, user controls, progress, approvals, and persistent data

The frontend should not merely be visually attractive. It should make long-running AI workflows understandable.

Expected capabilities:

- authentication
- user-specific workspaces
- responsive phone and desktop experience
- persistent navigation
- visible workflow progress
- queued, running, blocked, failed, and complete states
- human approval interfaces
- editable preferences
- explainable model outputs
- source and evidence views
- clear error recovery

This phase may include mocked data and simulated backend behavior so the user experience can be validated before all AI capabilities are complete.

Definition of done:

- the major workflows can be represented clearly in the interface
- the user always understands what the system is doing
- the interface works on mobile and desktop
- interrupted sessions can resume from persistent state

### Phase 3: Candidate Intelligence and résumé system

Purpose:

- build a reliable understanding of who the candidate is, what the candidate has done, what the candidate can truthfully claim, and what the candidate wants next

Inputs may include:

- existing résumé
- free-form career description
- job responsibilities
- project descriptions
- education
- certifications
- publications
- target roles
- preferred locations
- compensation preferences
- work authorization
- industries of interest
- constraints and deal-breakers

The system should conduct a guided conversation to identify missing information and convert messy input into a structured, evidence-backed candidate profile.

The profile should distinguish:

- verified document-supported facts
- user-provided facts
- model inferences requiring confirmation
- recommendations

Each important claim should have provenance.

The résumé should be treated as a generated view of the candidate profile, not as the sole source of truth.

Expected outputs:

- structured candidate profile
- skills linked to evidence
- career narrative
- candidate constraints
- one or more job-search strategies
- résumé analysis
- recommended improvements
- professionally formatted résumé generation
- user-confirmed facts and corrections

Evaluation should measure:

- factual claim precision
- factual claim recall
- unsupported claim rate
- provenance accuracy
- schema validity
- duplicate detection
- missing-information discovery
- question usefulness
- recommendation acceptance
- latency
- cost

Definition of done:

- at least two users can independently create accurate profiles
- users can confirm, edit, reject, and add claims
- résumés can be generated without unsupported facts
- data persists across devices
- all model calls are traced and evaluated

### Phase 4: Job discovery, search, and ingestion

Purpose:

- find relevant jobs and convert them into a consistent, searchable representation

Expected capabilities:

- search approved job sources
- ingest jobs from company sites and other permitted sources
- normalize job data
- detect duplicates
- record when and where a job was found
- store application URLs
- track posting and closing dates
- support scheduled searches
- support user-entered job links
- allow filtered search in the frontend

Normalized fields may include:

- company
- title
- location
- work arrangement
- compensation
- responsibilities
- required qualifications
- preferred qualifications
- work authorization
- date posted
- application URL
- source
- retrieval timestamp

Definition of done:

- jobs can be discovered, normalized, stored, deduplicated, and searched reliably
- source and freshness are visible
- discovery can run repeatedly without creating uncontrolled duplicates

### Phase 5: Job fit evaluation and ranking

Purpose:

- determine which jobs are eligible, relevant, attractive, and worth applying to

The system should understand both the candidate profile and editable job-search preferences.

Preferences may include:

- target roles
- adjacent roles
- location
- remote, hybrid, or onsite preferences
- compensation
- industry
- company type
- relocation willingness
- application volume
- aspiration level
- deal-breakers

The user should be able to update preferences conversationally or through structured controls. The system should show its current understanding rather than hiding it in a prompt.

Expected outputs:

- hard eligibility result
- fit score or fit band
- supporting candidate evidence
- important gaps
- uncertainty
- application recommendation
- ranking priority
- explanation understandable to the user

Evaluation should measure:

- eligibility accuracy
- ranking consistency
- unsupported match claims
- required-skill coverage
- explanation quality
- candidate agreement
- false rejection of strong roles
- wasted recommendations
- latency and cost

Definition of done:

- the system consistently surfaces relevant jobs
- hard disqualifiers are handled reliably
- every recommendation is explainable
- user feedback can update future prioritization

### Phase 6: Tailored application materials

Purpose:

- prepare job-specific materials grounded in the candidate profile

Expected capabilities:

- tailored résumé
- tailored cover letter when useful
- short-answer responses
- project summaries
- recruiter messages
- document versioning
- comparison against the source profile
- unsupported-claim detection
- approval before use

Every factual statement should be traceable to confirmed candidate evidence.

Evaluation should measure:

- factual consistency
- requirement coverage
- relevance
- human edit rate
- document acceptance
- formatting reliability
- cost and latency

Definition of done:

- the user can review all generated materials directly in the application
- unsupported claims are blocked or clearly flagged
- approved documents are versioned and linked to the target job

### Phase 7: Application execution

Purpose:

- assist with completing applications across heterogeneous application systems

This is expected to be one of the most difficult phases because application sites differ, browser automation is fragile, CAPTCHA and authentication may intervene, and consequential questions require human judgment.

Expected capabilities:

- open the correct application workflow
- populate known fields
- upload approved documents
- detect unknown or uncertain questions
- pause for user input
- handle authentication checkpoints
- allow the user to take over when necessary
- resume after user intervention
- verify successful submission
- avoid duplicate applications

The system should support patterns such as:

- asking the user to confirm continued presence
- requesting takeover for CAPTCHA or login
- clearly showing the action currently underway
- preserving progress after interruption

Human approval should be required before final submission unless a future policy explicitly permits otherwise.

Evaluation should measure:

- successful completion rate
- correct field population
- unnecessary user intervention
- recovery after interruption
- duplicate prevention
- submission confirmation accuracy
- browser-action latency
- cost

Definition of done:

- the system can reliably assist with a defined set of application platforms
- failure states are understandable
- users can resume interrupted applications
- no application is submitted without the required approval

### Phase 8: Email integration, responses, and lifecycle management

Purpose:

- manage the complete application lifecycle after submission

Expected capabilities:

- connect approved email accounts
- identify job-related correspondence
- link messages to the correct application
- detect interview invitations, rejections, requests, and offers
- notify the user
- suggest next actions
- track deadlines
- maintain application status history
- support follow-up reminders
- help prepare responses without sending them unexpectedly

Possible application states include:

```text
DISCOVERED
→ EVALUATED
→ SAVED
→ DOCUMENTS_READY
→ APPROVED
→ APPLICATION_IN_PROGRESS
→ SUBMITTED
→ CONFIRMED
→ INTERVIEWING
→ OFFERED | REJECTED | WITHDRAWN | EXPIRED
```

Definition of done:

- messages can be associated with applications accurately
- important replies and deadlines are surfaced
- application status remains current
- notifications are useful without becoming noisy

### Phase 9: Learning, optimization, and reusable framework

Purpose:

- use accumulated evaluations and real outcomes to improve the system and extract a reusable agent-development framework

Expected work:

- compare model and prompt performance over time
- analyze quality, latency, and cost
- improve routing policies
- study human correction patterns
- study application outcomes
- refine job ranking
- refine résumé strategies
- improve failure recovery
- extract reusable infrastructure and engineering practices

The goal is not necessarily immediate model fine-tuning. Initial improvements may come from better workflows, prompts, schemas, retrieval, validation, or routing.

Definition of done:

- major components have measurable baselines and improvement histories
- production choices are tied to evaluation evidence
- reusable architecture and an engineering playbook are documented
- the project can seed future agentic applications

---

## Stage planning template

Before implementing a major stage, the following should be defined:

### Purpose

What user problem does the stage solve?

### Inputs

What information does it receive, and from where?

### Outputs

What typed data, decisions, documents, or state transitions does it produce?

### Workflow

Which steps are deterministic, model-powered, agentic, or human-controlled?

### Data model

What must be stored permanently? What is transient execution state?

### Risks and failure modes

What can go wrong, and how will the system detect and handle it?

### Research questions

Which tools, frameworks, models, or approaches require comparison?

### Evaluation dataset

What canonical, synthetic, difficult, and real cases will be used?

### Metrics

What quality, safety, operational, user-experience, and cost metrics matter?

### Baseline

What is the simplest implementation, and how well does it perform?

### Experiments

Which models, prompts, tools, or workflow designs will be compared?

### Definition of done

What measurable conditions must be satisfied before the stage is considered complete?

### Interview evidence

What diagrams, traces, reports, experiments, and lessons will demonstrate the work?

---

## Research and technology-selection policy

The project should not attempt to evaluate every available technology.

For important decisions:

1. Identify the actual requirements.
2. Research the strongest realistic options.
3. Compare them using explicit criteria.
4. Run a small spike or experiment when the decision is consequential or uncertain.
5. Document the selection and rejected alternatives.
6. Record tradeoffs and revisit conditions.

Examples of areas requiring research include:

- workflow orchestration
- model gateways
- local inference
- hosted model providers
- database hosting
- object storage
- job queues
- browser automation
- tracing
- evaluation
- prompt management
- authentication
- deployment
- security
- email integration

The project should sometimes use an alternative technology for a focused component or experiment when doing so creates meaningful comparative experience. This should not become uncontrolled duplication.

---

## Interview and portfolio goals

The final project should allow the owner to answer questions such as:

- Why was the prototype replaced instead of extended?
- Why use explicit workflows instead of one autonomous agent?
- Why was LangGraph selected or rejected?
- Why was PostgreSQL selected?
- How are durable product state and workflow checkpoints separated?
- How does local Ollama execution work securely?
- How are hosted and local models compared?
- How is ground truth created?
- How are LLM judges calibrated?
- How are prompts and model versions tracked?
- How are regressions detected?
- How are hallucinated résumé claims prevented?
- How are high-impact actions supervised?
- How is browser automation recovered after failure?
- How is cost measured and optimized?
- What changed because of an experiment?
- What architectural decision was reversed, and why?
- What would need to change at larger scale?

The strongest résumé bullets should eventually include measured results rather than only technology names.

Examples of the intended form:

- Architected a stateful, human-supervised agentic platform using explicit workflows, persistent state, local and hosted LLMs, and production tracing.
- Built a provenance-aware candidate intelligence system that converted résumés and conversational input into structured profiles while preventing unsupported professional claims.
- Developed versioned evaluation datasets and automated scorers to benchmark model and prompt configurations across factuality, completeness, latency, and cost.
- Implemented evidence-based routing between local and hosted models, reducing hosted inference cost while maintaining required quality thresholds.

Actual claims and metrics will be added only after they are demonstrated.

---

## Initial project principles

1. Preserve the prototype as Phase 0.
2. Build the production system independently.
3. Document before broad implementation.
4. Keep workflows explicit.
5. Use agents only where autonomy adds value.
6. Store durable state outside model context.
7. Keep users and their data isolated.
8. Require human approval for consequential actions.
9. Make model providers replaceable.
10. Evaluate every important model-powered capability.
11. Track quality, latency, and cost.
12. Treat model judges as tools, not truth.
13. Record failed approaches and changed decisions.
14. Make the system understandable on mobile and desktop.
15. Make every major decision interview-defensible.
16. Extract a reusable engineering playbook from the project.

---

## Current status

- Phase 0 rapid prototype: complete and preserved in `ApplyGo-prototype`
- Production repository: initialized
- High-level vision and roadmap: documented in this README
- Next phase: architecture, research, evaluation planning, and documentation structure
- Application code: intentionally not started in this repository

The immediate goal is not to build features quickly. It is to establish a clear, evidence-driven plan for building and evaluating ApplyGo as a production-oriented agentic system.
