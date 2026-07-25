# Phases and Exit Criteria

## Phase 0 — Prototype evidence

Purpose: preserve lessons from the rapid prototype without treating its architecture as production guidance.

Exit criteria:

- major workflow stages and failure modes are documented
- useful UI and behavior patterns are identified
- prototype data and code are not silently imported into the new system

## Phase 1 — Discovery and product definition

Deliverables:

- measured current-state workflow
- market and substitute analysis
- product thesis and boundaries
- capability map and initial requirements
- progressive-autonomy model
- evidence register and research backlog

Exit criteria:

- at least three real application sessions have timing and interruption data
- the user can explain the custom-build rationale without claiming all existing tools are poor
- build, integrate, prototype, and manual capabilities are separated
- high-risk assumptions are converted into technical spikes

## Phase 2 — Architecture spikes

Required spikes:

1. candidate evidence schema and claim provenance
2. PostgreSQL persistence and multi-profile isolation
3. model adapter with one hosted and one local/OpenAI-compatible provider
4. representative fit-analysis evaluation set
5. local Playwright application flow
6. Steel remote-session comparison
7. phone approval and browser handoff
8. durable workflow comparison: explicit state machine, LangGraph, and/or Temporal
9. MLflow/OpenTelemetry trace proof of concept

Exit criteria:

- ADRs accepted for the first production architecture
- representative failure and restart tests pass
- cost and latency baselines exist
- no mandatory vendor lacks an adapter boundary

## Phase 3 — Candidate Intelligence

Build the verified candidate profile, evidence store, preferences, constraints, reusable answers, and onboarding workflow.

Exit criteria:

- two isolated users can maintain profiles
- evidence can be imported, reviewed, versioned, and exported
- generated claims always identify supporting evidence or fail closed
- profile changes are auditable

## Phase 4 — Job Intelligence

Build official-source monitoring, normalization, deduplication, extraction, filtering, and fit ranking.

Exit criteria:

- configured sources run on schedule
- duplicate and stale-job handling meet labeled thresholds
- rankings explain evidence and uncertainty
- user overrides become evaluation cases

## Phase 5 — Application Preparation

Build job-specific evidence selection, résumé/letter generation, answers, artifact versioning, and approval.

Exit criteria:

- no unsupported claims on the regression set
- documents are linked to job, profile version, prompt/model version, and approval
- generated output is editable and rerunnable without losing history

## Phase 6 — Supervised Execution

Build deterministic browser adapters, checkpointing, exceptions, phone approvals, and submission evidence.

Exit criteria:

- representative ATS flows complete at autonomy level 2 or 3
- restarts do not duplicate external actions
- CAPTCHA and sensitive fields pause correctly
- user can observe, stop, take over, and resume

## Phase 7 — Progressive Autonomy

Promote proven actions to policy-bounded automatic operation.

Exit criteria:

- each promoted capability has a versioned evaluation set and thresholds
- circuit breakers and demotion rules are active
- the user can inspect every automated submission and its evidence
- autonomy can be configured by user, job type, site class, and action

## Immediate next work

1. publish and review this documentation portal
2. measure real job-search sessions instead of relying on provisional timing
3. create ADRs for the accepted discovery conclusions
4. implement the candidate-evidence schema spike
5. benchmark local Playwright versus Steel on representative application flows
