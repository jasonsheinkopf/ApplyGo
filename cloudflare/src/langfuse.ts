/**
 * Sends every LLM call to Langfuse (https://langfuse.com) for tracing, cost, and history.
 *
 * llm.ts's traced() wrapper is already the single choke point every model call passes through --
 * see its own header comment -- and it already captures everything a call needs (task, provider,
 * model, tier, prompt, response, tokens, cost, latency, ok/error). This module's only job is to
 * shape that into Langfuse's ingestion event format and POST it.
 *
 * Deliberately raw `fetch` against Langfuse's documented ingestion endpoint
 * (`POST /api/public/ingestion`), not the `langfuse` npm SDK. The published v3 SDK is marked
 * deprecated in favor of a v4 rewrite built on OpenTelemetry, and wiring a generic OTEL SDK
 * correctly inside a Cloudflare Workers isolate -- where a naive setup can leak span context
 * across concurrent requests sharing the same isolate -- is a real correctness hazard this app
 * already reasons carefully about elsewhere (see index.ts's attachTraceSink comment). A single
 * stateless POST per call sidesteps that entirely and matches how the rest of this file already
 * talks to every other provider.
 *
 * Every function here follows the same rule llm.ts's own record() does: observability must never
 * be able to break the call it's observing. Nothing in this file throws; a Langfuse outage or a
 * missing API key just means nothing gets sent this time.
 */

import type { LlmTrace } from "./llm";

export interface LangfuseEnv {
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  /** Defaults to Langfuse Cloud's EU region. Set to https://us.cloud.langfuse.com for the US region, or a self-hosted URL. */
  LANGFUSE_HOST?: string;
}

export function langfuseConfigured(env: LangfuseEnv): boolean {
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

function host(env: LangfuseEnv): string {
  return (env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/$/, "");
}

function authHeader(env: LangfuseEnv): string {
  return `Basic ${btoa(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`)}`;
}

/**
 * One LLM call becomes one Langfuse trace with a single generation observation inside it. Batched
 * calls (screenJobsBatch, assessJobFitBatch) already cover many postings in one call, so this is
 * naturally the right granularity for "one thing that happened" without threading a request-scoped
 * session id through the dozen-plus call sites that currently just pass `env` straight through.
 *
 * Returns the Langfuse trace id on success so the caller can store it alongside the existing D1
 * trace row -- that's what lets the dev console link straight into the richer Langfuse view for
 * the same call -- or null when Langfuse isn't configured or the request failed.
 */
export async function sendToLangfuse(
  env: LangfuseEnv,
  trace: Omit<LlmTrace, "langfuseTraceId">,
): Promise<string | null> {
  if (!langfuseConfigured(env)) return null;

  const traceId = crypto.randomUUID();
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - Math.max(0, trace.latencyMs));

  const batch = [
    {
      id: crypto.randomUUID(),
      timestamp: endTime.toISOString(),
      type: "trace-create" as const,
      body: {
        id: traceId,
        timestamp: startTime.toISOString(),
        name: trace.task,
        input: trace.prompt,
        output: trace.ok ? trace.response : null,
        tags: [trace.provider, trace.tier, trace.ok ? "ok" : "error"],
        metadata: { provider: trace.provider, tier: trace.tier },
      },
    },
    {
      id: crypto.randomUUID(),
      timestamp: endTime.toISOString(),
      type: "generation-create" as const,
      body: {
        id: crypto.randomUUID(),
        traceId,
        name: trace.task,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        model: trace.model,
        input: trace.prompt,
        output: trace.ok ? trace.response : null,
        usageDetails: { input: trace.inputTokens, output: trace.outputTokens },
        ...(trace.costUsd != null ? { costDetails: { total: trace.costUsd } } : {}),
        level: trace.ok ? "DEFAULT" : "ERROR",
        ...(trace.ok ? {} : { statusMessage: trace.error ?? "error" }),
        metadata: { tier: trace.tier },
      },
    },
  ];

  try {
    const res = await fetch(`${host(env)}/api/public/ingestion`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader(env) },
      body: JSON.stringify({ batch }),
    });
    // The ingestion endpoint can 207 partial-success a batch -- either way, the trace id we
    // generated is what future links point at, so there's nothing more to extract from the body.
    if (!res.ok && res.status !== 207) return null;
    return traceId;
  } catch {
    return null;
  }
}

/**
 * The project id behind a Langfuse key pair, resolved once per isolate and cached in module
 * scope -- module-level state in a Worker is safe to share across requests within one isolate the
 * same way a top-level constant is, since the module is evaluated once per isolate. It practically
 * never changes for a given key pair, so there's no reason to look it up on every trace.
 *
 * Used only to build a deep link from the dev console straight into a specific Langfuse trace
 * (`/project/{id}/traces/{traceId}`) -- the ingestion API itself doesn't need it. A failed lookup
 * just means the dev console falls back to linking the dashboard's root instead of one trace.
 */
let cachedProjectId: Promise<string | null> | null = null;

async function resolveProjectId(env: LangfuseEnv): Promise<string | null> {
  if (!langfuseConfigured(env)) return null;
  if (!cachedProjectId) {
    cachedProjectId = (async () => {
      try {
        const res = await fetch(`${host(env)}/api/public/projects`, {
          headers: { authorization: authHeader(env) },
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { data?: { id?: string }[] };
        return data.data?.[0]?.id ?? null;
      } catch {
        return null;
      }
    })();
  }
  return cachedProjectId;
}

/**
 * A link a human can click from the dev console to see one call's full trace in Langfuse -- the
 * timeline, the generation's cost breakdown, and (once configured) any LLM-as-judge scores. Falls
 * back to the plain dashboard root when the project id can't be resolved, so a lookup failure
 * degrades to "open Langfuse" rather than a broken link.
 */
export async function langfuseTraceUrl(env: LangfuseEnv, traceId: string): Promise<string> {
  const projectId = await resolveProjectId(env);
  const base = host(env);
  return projectId ? `${base}/project/${projectId}/traces/${traceId}` : base;
}
