# ADR-015: Route model work by task and execution mode

- Status: accepted
- Date: 2026-07-26
- Owners: ApplyGo project

## Context

ApplyGo can use hosted APIs, local models, Claude Code on a personal computer, and Claude Code Routines that consume the owner's subscription quota. These options differ materially in speed, availability, cost, privacy, and whether they return synchronously.

The project does not yet have enough evidence to choose one permanent provider for every task. Hard-coding one provider now would create avoidable lock-in and make later evaluation harder.

## Decision

ApplyGo will route model work using three independent dimensions:

1. task type
2. provider/model
3. execution mode: synchronous, local, or queued

A default provider remains available for simple installations. Task-specific routes override it when configured.

Supported initial adapters are mock, OpenAI API, Anthropic API, Ollama, generic OpenAI-compatible endpoints, local Claude Code, and Claude Code Routines.

Claude subscription access will never be represented as a normal Anthropic API key. Local Claude Code and Claude Code Routines are explicit provider types, and ApplyGo will not silently fall back from them to separately billed API execution.

## Consequences

- provider selection can change without changing domain workflows
- slow subscription-backed work can be assigned to queued tasks
- fast interactive work can use a hosted API or sufficiently fast local model
- local-only users can operate without a hosted model
- model runs record provider, model, execution mode, latency, and usage metadata
- the frontend must eventually expose simple and advanced routing configuration
- queued Routine execution requires durable result collection before it can power synchronous screens

## Validation

The decision is validated when:

- the existing fit-assessment path executes through the router
- default and task-specific routes are covered by tests
- mock, hosted API, local endpoint, Claude Code, and Routine adapters share one application boundary
- no browser receives provider credentials
- evaluation data can compare task/provider combinations without changing business logic
