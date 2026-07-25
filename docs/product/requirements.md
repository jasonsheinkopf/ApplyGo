# Requirements

## Functional requirements

### Candidate and household support

- support multiple isolated user profiles, beginning with the repository owner and his wife
- maintain verified work history, education, skills, accomplishments, preferences, constraints, and reusable application answers
- associate every generated claim with candidate evidence or mark it as requiring review
- support profile export and backup

### Job discovery

- monitor configured official employer sources on a schedule
- ingest aggregator results as supplemental rather than authoritative records
- normalize job fields and retain the original source
- detect duplicate and materially changed postings
- explain inclusion, exclusion, and uncertainty

### Fit and preparation

- map requirements to verified evidence
- produce a fit assessment with strengths, gaps, uncertainties, and recommendation
- generate versioned résumé, cover-letter, and application-answer artifacts
- prohibit unsupported claims and expose evidence references to reviewers
- allow user edits to update future behavior without silently rewriting source evidence

### Execution

- support deterministic browser automation first and agentic control for ambiguous steps
- persist workflow checkpoints and resume after interruption
- maintain a live execution state visible to the user
- pause on sensitive questions, CAPTCHA, material ambiguity, policy failures, and low confidence
- capture submission confirmation and artifacts
- allow phone-based approval and remote handoff

### Operations

- track applications, communications, interviews, deadlines, and outcomes
- connect email and calendar events to application records
- surface an actionable review queue rather than raw event volume
- preserve a complete action and decision history

## Non-functional requirements

### Reliability

- operations must be idempotent where practical
- retries must not create duplicate submissions or communications
- workflows must expose current state, last successful checkpoint, and failure reason
- external side effects require a durable intent and confirmation record

### Security and privacy

- secrets must not appear in prompts, traces, screenshots, or repository files
- user data must be isolated by profile
- sensitive fields require explicit schema and redaction policy
- browser credentials should remain in secure local or managed browser profiles where possible
- logs and evaluation datasets must support redaction and retention controls

### Portability

- model providers must be replaceable through a common application interface
- local and hosted inference must both be supported
- the initial deployment should run on one computer, but state and control should be accessible from other devices
- the system should support self-hosting and avoid mandatory proprietary infrastructure

### Observability and evaluation

- every model and browser run must be traceable to a workflow and application
- capture latency, token/usage cost, retries, confidence, user corrections, and outcome
- separate offline evaluation from production tracing
- define stage-specific metrics and promotion criteria for progressive autonomy

### Maintainability

- prefer a modular monolith with explicit boundaries over premature microservices
- use typed domain models and structured outputs
- record significant architecture choices as ADRs
- keep framework-specific code behind adapters

## Definition of done for an application workflow

An application is complete only when:

1. the authoritative job and selected candidate profile are identified
2. generated materials are versioned and grounded
3. required approvals are satisfied
4. browser execution reaches a confirmed terminal state
5. submission evidence or a clear abandonment reason is stored
6. artifacts and communications are linked to the application
7. metrics and trace data are recorded without leaking secrets
