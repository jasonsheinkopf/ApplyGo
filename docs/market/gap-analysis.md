# Competitive Gap Analysis

## Core gap

The market contains strong point solutions, but the candidate commonly remains responsible for moving context among them. ApplyGo’s custom-build rationale is the absence of a user-controlled system that combines durable candidate evidence, job discovery, grounded document generation, supervised execution, and longitudinal outcome state under one policy model.

## Gap matrix

| Capability | Point tools often provide | ApplyGo requirement |
|---|---|---|
| Candidate profile | reusable autofill data or uploaded résumé | structured evidence with provenance, confidence, and version history |
| Job discovery | aggregator feed or alerts | official-source monitoring, normalization, deduplication, and user policy |
| Fit analysis | score or keyword match | explainable evidence-to-requirement mapping with uncertainty |
| Documents | generated résumé or letter | versioned artifacts grounded only in verified evidence |
| Form execution | browser autofill or autonomous clicks | durable, resumable workflow with deterministic-first execution |
| Human control | review screen or final click | explicit policy gates that can change by autonomy level and risk |
| Model choice | vendor-selected model | provider-agnostic routing, local option, task-specific evaluation |
| Tracking | list or kanban | full event history connected to documents, browser runs, email, and outcomes |
| Learning | generic recommendation improvement | user corrections and outcomes tied back to source evidence and policies |
| Portability | vendor account | cloneable, self-hostable personal infrastructure |

## Build, integrate, or leave manual

### Build

- candidate evidence and preference model
- job/application state model
- workflow policy and progressive-autonomy controls
- fit and claim provenance
- artifact versioning
- integration adapters
- evaluation harness and quality gates
- user-facing review and intervention queue

### Integrate

- hosted and local model runtimes
- deterministic browser engines and optional remote browser infrastructure
- email and calendar providers
- authentication, object storage, document conversion, and notifications
- observability standards and selected tooling

### Leave manual by default

- CAPTCHA when the site expects a human
- legal and sensitive declarations
- ambiguous questions without verified source data
- final submission at early autonomy levels
- personal desirability and negotiation decisions

## Decision

Proceed with ApplyGo as a custom integrated platform, but reject a “build everything” interpretation. The architecture should make commodity services replaceable and reserve custom code for the user-specific state, policy, coordination, and evaluation that form the product’s actual differentiation.
