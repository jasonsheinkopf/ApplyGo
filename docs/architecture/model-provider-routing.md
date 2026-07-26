# Task-Aware Model Provider Routing

ApplyGo separates **what work must be done** from **which model and execution method performs it**. This permits the project to begin before a permanent provider decision is made.

## Supported provider families

| Provider | Authentication | Billing | Execution characteristics |
|---|---|---|---|
| Mock | none | none | deterministic tests and development |
| Ollama | local service | no per-call fee | private, computer must be available |
| OpenAI-compatible | endpoint-specific | local or provider-specific | supports LM Studio, vLLM, LocalAI, and similar servers |
| OpenAI API | API key | separate usage billing | synchronous and suitable for interactive work |
| Anthropic API | API key | separate usage billing | synchronous and suitable for interactive work |
| Claude Code local | Claude Code login | Claude subscription quota | runs on the user's computer; slower than a direct API and unavailable when the computer is off |
| Claude Code Routine | Routine trigger URL/token | Claude subscription quota | queued/background execution through a configured Claude Code Routine |

A ChatGPT or Claude consumer subscription is not represented as a normal API key. Claude subscription access is supported through the local Claude Code executable or an explicitly configured Claude Code Routine.

## Task types

The router currently defines:

- fit assessment
- document extraction
- document drafting
- background research
- interactive assistance

More task types can be added without changing provider adapters.

## Execution modes

- `synchronous`: the caller waits for the result
- `local`: execution requires the user's computer or local runtime
- `queued`: work is handed to an asynchronous workflow such as a Claude Code Routine

The execution mode is recorded with model-run metadata. A future workflow service will use it to decide whether to wait, queue, or request a connected local worker.

## Configuration

A default provider/model remains available:

```dotenv
APPLYGO_MODEL_PROVIDER=ollama
APPLYGO_MODEL_NAME=qwen2.5
```

Task-specific routing overrides the default:

```dotenv
APPLYGO_MODEL_ROUTES_JSON={"fit_assessment":{"provider":"openai","model":"YOUR_MODEL","execution_mode":"synchronous"},"background_research":{"provider":"claude_routine","model":"sonnet","execution_mode":"queued"},"document_drafting":{"provider":"claude_code","model":"subscription-default","execution_mode":"local"}}
```

The frontend will later present this as a simple default choice plus an advanced task-routing screen. Users should not need to edit JSON manually in the finished product.

## Initial routing policy

No permanent task assignment is accepted yet. The recommended starting hypothesis is:

| Work | Initial candidate |
|---|---|
| deterministic tests | mock |
| low-cost local extraction experiments | Ollama or OpenAI-compatible local model |
| interactive fit analysis | hosted API or sufficiently fast local model |
| deep queued research | Claude Code Routine |
| local subscription-based drafting | Claude Code local |

Each task/provider combination must be evaluated for grounding, malformed output, latency, cost, privacy, and user correction rate before becoming the default.

## Security

- API keys remain backend or worker secrets and are never returned to browser JavaScript.
- Claude Routine trigger credentials are deployment secrets, not device enrollment tokens.
- Claude Code local uses the existing authenticated local Claude session.
- Provider output must remain constrained by verified candidate evidence.
- The router must never silently fall back from subscription execution to separately billed API execution.

## Current implementation boundary

The fit-assessment path now uses the router. Provider adapters exist for mock, OpenAI, Anthropic, Ollama, generic OpenAI-compatible endpoints, local Claude Code, and Claude Code Routines.

The Claude Routine adapter can trigger a configured Routine, but durable result collection is a later workflow feature. It is therefore intended for queued work rather than immediate UI responses. Future frontend work will add provider detection, connection testing, model discovery, secure credential setup, and task assignment.
