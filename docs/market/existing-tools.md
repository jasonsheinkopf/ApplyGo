# Existing Workflow Tools

This page records the first-pass substitute analysis. Product behavior and pricing change frequently; detailed evidence should be refreshed before implementation decisions.

## Simplify

Simplify is an important benchmark because its browser copilot targets a major ApplyGo pain point: filling job applications from a reusable profile. It is likely the strongest answer to “why not just use an existing extension?” for form completion.

ApplyGo still has a distinct purpose if it provides:

- user-owned structured evidence rather than only autofill profile data
- official-source discovery and persistent ranking policy
- transparent claim provenance in generated documents and answers
- workflow state that survives browser failures and spans applications
- model-provider choice and local/self-hosted options
- integrated email, outcome, and evaluation history
- configurable progressive autonomy rather than a fixed product workflow

The correct strategy is to study Simplify’s interaction model and avoid rebuilding convenience features without differentiation.

## Claude in Chrome and general browser assistants

Claude in Chrome can read, click, type, navigate, and fill forms in the user’s desktop Chrome session. It is useful for supervised, in-the-moment work and may be a practical interim tool. It is not supported on mobile devices, and a paid Claude subscription is not equivalent to a stable application API contract.

For ApplyGo, a browser assistant can be:

- an interim manual copilot
- a development and testing aid
- a possible optional execution adapter

It should not be the sole production architecture because ApplyGo needs durable job/application state, deterministic recovery, auditable policy gates, and provider independence.

## General AI chat subscriptions

A $20 consumer subscription may provide excellent interactive assistance but usually does not grant programmatic API use for an independent application. ApplyGo should distinguish:

- consumer chat/desktop subscriptions used interactively
- provider APIs billed separately and suitable for programmatic calls
- local models operated through Ollama or another local runtime
- provider aggregators such as OpenRouter

Where a supported local connector or command-line integration exists, it can be evaluated as an optional adapter. The core system should not assume that consumer-plan credentials may be automated or redistributed.

## Résumé and ATS tools

Products focused on tailoring, keyword matching, and résumé scoring can be useful references or integrations. Their typical limitation is not document quality alone; it is lack of shared state with discovery, browser execution, approvals, communications, and outcomes.

## Autonomous application services

These validate demand for reduced application labor, but volume-first operation can conflict with ApplyGo’s goals. The relevant comparison dimensions are:

- factual grounding
- targeting quality
- visibility into actions
- control over final submission
- safe handling of sensitive questions
- recovery and auditability
- account and terms-of-service risk

## Browser autofill and password managers

Traditional autofill remains the best tool for many deterministic fields. ApplyGo should use browser-native or password-manager capabilities where appropriate rather than asking an LLM to type names, addresses, and repeated contact data. Models should focus on interpretation and exceptions, not replace reliable deterministic automation.

## Build implication

ApplyGo is justified as an integrated control plane, not as a claim that no useful tools exist. The design should permit users to keep using preferred extensions or assistants while ApplyGo manages evidence, policy, artifacts, state, and next actions.
