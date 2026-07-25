# Models and Orchestration

ApplyGo should be model-provider agnostic, but provider agnosticism does not mean pretending all models are interchangeable. Each workflow stage requires measured quality, cost, latency, privacy, and structured-output reliability.

## Model access strategy

Define a small application interface for:

- structured extraction
- classification and ranking
- evidence-grounded generation
- tool-using reasoning
- embeddings and reranking

Adapters may target:

- OpenAI APIs
- Anthropic APIs
- Google APIs
- OpenRouter or another routing provider
- Ollama or an OpenAI-compatible local endpoint
- vLLM for a later self-hosted serving path

Consumer chat subscriptions should not be treated as API credentials. Interactive Claude, ChatGPT, or Gemini use can supplement the workflow, but production automation requires a supported programmatic interface or a clearly isolated optional adapter.

## Task routing

| Task | Preferred approach |
|---|---|
| normalize dates, locations, compensation | deterministic parsing first |
| classify obvious job constraints | small/fast model or rules |
| extract requirements | structured-output model with evaluation set |
| match evidence to requirements | retrieval plus reasoning model |
| generate résumé bullets or letters | strong model with strict evidence context |
| browser page interpretation | multimodal/tool-capable model only for exceptions |
| deduplication | hashes, normalized fields, embeddings as secondary signal |
| reranking | task-specific reranker or evaluated LLM judge |

## LangChain, LangGraph, and alternatives

These tools solve different problems:

- **LangChain** provides integrations and application abstractions. It can accelerate experiments but may add unnecessary indirection if only a few native SDKs and tools are needed.
- **LangGraph** provides stateful graph execution, checkpoints, and human interrupts for agent workflows. It is a credible candidate for bounded AI subworkflows.
- **Temporal** provides durable general-purpose workflows, strong retry semantics, timers, and long-running coordination. It is a credible candidate for the application lifecycle and browser operations.
- **Celery or a simpler queue** may be sufficient for early background tasks but does not by itself provide the same durable workflow semantics.
- **Prefect** is oriented toward Python workflow orchestration and may be useful for scheduled acquisition/evaluation pipelines.

## Recommended separation

Do not use one “agent graph” as the entire application. Separate:

1. durable business workflow state: job acquisition, application lifecycle, waits, approvals, retries
2. bounded model workflows: requirement extraction, fit analysis, document generation, browser recovery
3. deterministic services: persistence, validation, file generation, field mapping, notifications

A possible future combination is Temporal for durable system workflows and LangGraph or a lightweight typed graph for complex model reasoning. That combination should only be adopted if prototypes show that both layers earn their operational cost.

## Decision spike

Implement the same representative application-preparation workflow using:

- explicit Python state machine plus queue
- LangGraph with persistence and interrupts
- Temporal workflow with model activities

Compare code clarity, replay/retry behavior, human wait handling, observability, local setup, and failure recovery. Select based on measured system requirements rather than agent-framework popularity.
