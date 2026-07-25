# Technology Landscape

ApplyGo spans several distinct technical responsibilities. Frameworks should be compared within their responsibility rather than as interchangeable “agent tools.”

## Layers

| Layer | Responsibility | Candidate approaches |
|---|---|---|
| Model access | reasoning, extraction, generation, embeddings | native provider SDKs, OpenRouter, Ollama, vLLM |
| Application AI | typed prompts, tools, structured outputs | native SDKs, PydanticAI, LangChain, custom adapters |
| Workflow durability | long-running state, retries, timers, human waits | Temporal, LangGraph persistence, Prefect, Celery plus explicit state |
| Browser execution | deterministic and agentic web interaction | Playwright, browser-use, Stagehand, Steel, local extension bridge |
| Data | transactional state, search, vectors, artifacts | PostgreSQL, pgvector, object storage, full-text search |
| Evaluation | datasets, experiments, metrics, regression gates | MLflow, promptfoo, DeepEval, Ragas, custom harnesses |
| Tracing | model/tool/browser spans and cost | OpenTelemetry, MLflow tracing, LangSmith, Phoenix |
| Application | APIs, UI, workers, notifications | FastAPI, modern web frontend, background workers |
| Deployment | local, hybrid, or hosted operation | Docker Compose, managed database, remote browser, secure tunnel |

## Selection principles

1. Prefer standards and explicit interfaces before framework-specific abstractions.
2. Use deterministic code for deterministic tasks.
3. Use models for interpretation, uncertainty, and recovery—not basic field copying.
4. Separate durable business workflow state from ephemeral agent conversation state.
5. Keep model and browser providers behind adapters.
6. Select observability and evaluation tools based on evidence needs, not brand alignment.
7. Begin as a modular monolith that can run locally and evolve toward hybrid deployment.

## Initial direction

- Python backend with typed domain models
- PostgreSQL as system of record; SQLite may be allowed only for very early local bootstrap
- Playwright as the baseline browser control layer
- Steel evaluated as optional remote-browser infrastructure, not a mandatory dependency
- model-provider abstraction supporting OpenAI, Anthropic, and local OpenAI-compatible endpoints
- MLflow retained as the leading experiment/evaluation candidate because it supports the project’s broader ML engineering goals
- OpenTelemetry-compatible tracing considered a portability requirement
- orchestration decision deferred until durable human waits, retry semantics, and workflow volume are prototyped
