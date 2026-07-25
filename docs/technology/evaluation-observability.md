# Evaluation and Observability

ApplyGo must distinguish three related but different concerns:

1. **Tracing:** what happened during a specific run?
2. **Evaluation:** was the output or behavior good enough?
3. **Operational monitoring:** is the system healthy, reliable, and within cost policy?

## Required trace model

Every job, application, model call, browser step, user decision, artifact, and external side effect should share correlation identifiers. Traces should answer:

- which candidate profile and job were used?
- which evidence supported each generated claim?
- which model, prompt version, parameters, and tools were used?
- what did the browser observe and do?
- where did the workflow pause, retry, or fail?
- what did the user change or override?
- what did the run cost and how long did it take?

## Tool landscape

### MLflow

A strong candidate for experiment tracking, evaluation datasets, model/prompt comparisons, metrics, artifacts, and tracing. It aligns with the project goal of demonstrating disciplined ML engineering rather than only application logging.

### LangSmith

Strong developer experience for LangChain/LangGraph traces, datasets, and evaluations. It is most attractive if the application adopts those frameworks deeply; otherwise it can create ecosystem coupling.

### Arize Phoenix

Useful open-source LLM observability and evaluation option, particularly for traces and retrieval analysis.

### OpenTelemetry

The portability layer for distributed traces and operational telemetry. ApplyGo should emit or preserve OpenTelemetry-compatible context even when a higher-level AI tool is used.

### promptfoo, DeepEval, and Ragas

Useful focused evaluation tools. Selection should depend on the test type rather than attempting to standardize every evaluation into one platform.

## Recommended initial stack

- MLflow for experiment tracking, datasets, artifacts, and primary AI evaluation history
- OpenTelemetry-compatible application and worker traces
- structured domain events stored in the application database
- browser-native Playwright traces for execution debugging
- a small custom evaluation harness that can call specialized libraries when needed

LangSmith remains an optional comparison candidate if LangGraph becomes central.

## Stage-specific metrics

### Job discovery

- source freshness
- duplicate precision/recall
- relevant-job recall on a labeled sample
- false exclusion rate

### Fit assessment

- requirement extraction accuracy
- evidence mapping precision
- unsupported match rate
- ranking agreement and user override rate

### Document generation

- unsupported claim count
- evidence coverage
- factual correction rate
- style and relevance preference scores

### Browser execution

- completion rate by ATS/site version
- field accuracy before correction
- exception detection recall
- user interruptions per application
- recovery rate after restart
- duplicate side-effect count

### End-to-end

- human-active minutes per qualified application
- cost per completed workflow
- percentage completed within policy
- applications requiring rollback or correction
- time from job discovery to reviewed submission

## Evaluation governance

No workflow should receive greater autonomy based only on anecdotal success. Promotion requires a versioned dataset, defined thresholds, regression checks, and a rollback path. Production user corrections should become labeled evaluation cases after privacy review.
