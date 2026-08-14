/**
 * Sends every LLM call to Langfuse (https://langfuse.com) for tracing, cost, and history.
 *
 * llm.ts's traced() wrapper is already the single choke point every model call passes through --
 * see its own header comment -- and it already captures everything a call needs (task, provider,
 * model, tier, prompt, response, tokens, cost, latency, ok/error). This module's only job is to
 * shape that into one OTLP/HTTP JSON span and POST it.
 *
 * Deliberately raw `fetch` against Langfuse's OTLP/HTTP endpoint
 * (`POST /api/public/otel/v1/traces`), not a process-global OpenTelemetry SDK. A generic SDK's
 * ambient span context can leak across concurrent requests sharing a Cloudflare Workers isolate.
 * Building one standards-compliant OTLP JSON envelope per completed call keeps this exporter
 * stateless while using Langfuse's current v4 ingestion path.
 *
 * Every function here follows the same rule llm.ts's own record() does: observability must never
 * be able to break the call it's observing. Nothing in this file throws; a Langfuse outage or a
 * missing API key just means nothing gets sent this time.
 */

import type { LlmTrace } from "./llm";

export interface LangfuseEnv {
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  /** Standard Langfuse SDK setting. Preferred over the legacy ApplyGo-specific HOST alias. */
  LANGFUSE_BASE_URL?: string;
  /** Backward-compatible alias. Defaults to Langfuse Cloud's EU region when neither URL is set. */
  LANGFUSE_HOST?: string;
}

export function langfuseConfigured(env: LangfuseEnv): boolean {
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

function host(env: LangfuseEnv): string {
  return (env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/$/, "");
}

function authHeader(env: LangfuseEnv): string {
  return `Basic ${btoa(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`)}`;
}

function randomHex(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function attribute(key: string, value: string | number | string[]) {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "number") return { key, value: { doubleValue: value } };
  return { key, value: { arrayValue: { values: value.map((item) => ({ stringValue: item })) } } };
}

function unixNanos(date: Date): string {
  return (BigInt(date.getTime()) * 1_000_000n).toString();
}

/**
 * One LLM call becomes one Langfuse trace with a single root generation observation. Batched
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

  // OTLP requires a 16-byte lowercase-hex trace id and an 8-byte span id.
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - Math.max(0, trace.latencyMs));
  const attributes = [
    attribute("langfuse.trace.name", trace.task),
    attribute("langfuse.trace.tags", [trace.provider, trace.tier, trace.ok ? "ok" : "error"]),
    attribute("langfuse.observation.type", "generation"),
    attribute("langfuse.observation.input", JSON.stringify(trace.prompt)),
    attribute("langfuse.observation.model.name", trace.model),
    attribute("langfuse.observation.usage_details", JSON.stringify({ input: trace.inputTokens, output: trace.outputTokens })),
    attribute("langfuse.observation.level", trace.ok ? "DEFAULT" : "ERROR"),
    attribute("langfuse.observation.metadata.provider", trace.provider),
    attribute("langfuse.observation.metadata.tier", trace.tier),
  ];
  if (trace.ok) attributes.push(attribute("langfuse.observation.output", JSON.stringify(trace.response)));
  if (trace.costUsd != null) {
    attributes.push(attribute("langfuse.observation.cost_details", JSON.stringify({ total: trace.costUsd })));
  }
  if (!trace.ok) attributes.push(attribute("langfuse.observation.status_message", trace.error ?? "error"));

  const payload = {
    resourceSpans: [{
      resource: { attributes: [attribute("service.name", "applygo")] },
      scopeSpans: [{
        scope: { name: "langfuse-sdk", version: "applygo-otlp-v1" },
        spans: [{
          traceId,
          spanId,
          traceFlags: 1,
          name: trace.task,
          kind: 1,
          startTimeUnixNano: unixNanos(startTime),
          endTimeUnixNano: unixNanos(endTime),
          attributes,
          status: trace.ok ? { code: 0 } : { code: 2, message: trace.error ?? "error" },
        }],
      }],
    }],
  };

  try {
    const res = await fetch(`${host(env)}/api/public/otel/v1/traces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authHeader(env),
        "x-langfuse-ingestion-version": "4",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
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
