# Research Method

## Purpose

Research supports product and architecture decisions. It should identify both usable existing capabilities and unresolved gaps without treating vendor marketing as verified behavior.

## Source priority

1. official documentation, pricing, security, and API references
2. source repositories, releases, and issue trackers
3. direct product trials and reproducible experiments
4. independent technical analysis
5. user reports and community discussions

User reports are useful for discovering failure modes, but they do not establish prevalence by themselves.

## Evidence register fields

Every material claim should eventually record:

- claim
- source and access date
- evidence class: verified, reported, observed, or inferred
- affected workflow stage
- confidence
- decision impact
- expiration or recheck date for changing products and prices

## Comparison dimensions

Products and frameworks are compared on:

- workflow coverage
- structured candidate knowledge
- grounding and provenance
- provider independence
- durable state and recovery
- human-control model
- browser reliability and observability
- authentication and session persistence
- CAPTCHA and exception handling
- privacy and credential isolation
- self-hosting and portability
- cost at personal-use scale
- extensibility and maintenance burden

## Required experiments

Desktop research is insufficient for the highest-risk claims. The project should run controlled spikes for:

- three representative ATS families and one unknown/custom site
- local Playwright versus remote Steel sessions
- deterministic selectors versus agentic browser control
- session persistence and user handoff
- one hosted and one local model for fit extraction and form mapping
- restart recovery after browser, worker, and model failures
- trace redaction and secret handling

## Decision rule

A framework is not selected because it is popular or appears in an agent tutorial. It is selected only when its responsibility is clear and its benefit exceeds the added dependency, abstraction, operational cost, and failure surface.
