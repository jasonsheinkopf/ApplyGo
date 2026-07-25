# Problem and Product Thesis

## Problem statement

A serious job search is a fragmented, repetitive, stateful workflow. Candidates repeatedly search overlapping sources, interpret inconsistent job descriptions, reconstruct their own experience, tailor similar documents, re-enter structured facts, navigate different ATS interfaces, monitor email, and rebuild context for every follow-up.

Point products reduce individual tasks, but the candidate remains the integration layer. The user moves information among aggregators, company sites, AI chats, document editors, browser extensions, spreadsheets, inboxes, and application portals. This produces duplicated effort, inconsistent decisions, lost provenance, and weak learning from outcomes.

## Product thesis

ApplyGo should own the durable context and coordination layer across the job-search lifecycle. Its differentiation is not a single model call or autofill script. It is the combination of:

- a verified candidate evidence model
- persistent goals, constraints, and preferences
- official-source job discovery and normalization
- explainable fit assessment
- grounded, versioned application materials
- policy-controlled browser execution
- durable application state and recovery
- correspondence and outcome tracking
- evaluation of quality, cost, latency, and reliability

## Why custom development is justified

The custom-build rationale is strongest where multiple stages require shared state and user-specific policy. A résumé tool can tailor a résumé; an extension can fill fields; a general AI assistant can reason over a page. None of those capabilities alone creates a durable record that connects source evidence, job interpretation, generated claims, browser actions, approvals, application artifacts, responses, and eventual outcomes.

ApplyGo should therefore **build the coordination, state, policy, provenance, and evaluation layers** while integrating replaceable model, browser, communication, and infrastructure services.

## Intended users

The initial system is for the repository owner, his wife, trusted friends, and technically capable users who clone and configure the project. It is not initially a commercial SaaS product. This changes priorities:

- bring-your-own credentials are acceptable
- local and self-hosted operation matter
- extensibility matters more than zero-configuration onboarding
- transparent behavior matters more than maximizing application volume
- user control and data ownership matter more than vendor lock-in

## Non-goals

ApplyGo is not intended to:

- fabricate qualifications or claims
- evade application-site protections
- silently answer sensitive or legal questions
- maximize indiscriminate application volume
- guarantee employment outcomes
- replace candidate judgment about role desirability
- become dependent on one model provider or one browser vendor

## Success hypothesis

ApplyGo succeeds if it materially reduces repetitive effort while preserving factual accuracy, user control, observability, and recoverability. Its key metric is not applications per hour in isolation; it is **qualified applications completed per unit of human attention, with verified claims and traceable execution**.
