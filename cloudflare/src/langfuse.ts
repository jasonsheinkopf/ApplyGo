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
 * Trace-export functions follow llm.ts's rule that observability cannot break the call being
 * observed. Prompt retrieval is application input, so it fails clearly only when neither Langfuse
 * nor a last-known-good cached production prompt is available.
 */

import type { LlmTrace } from "./llm.ts";

export interface LangfuseEnv {
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  /** Standard Langfuse SDK setting. Preferred over the legacy ApplyGo-specific HOST alias. */
  LANGFUSE_BASE_URL?: string;
  /** Backward-compatible alias. Defaults to Langfuse Cloud's EU region when neither URL is set. */
  LANGFUSE_HOST?: string;
  /** Optional persistent last-known-good prompt cache (the application's existing D1 binding). */
  DB?: D1Database;
}

export type ManagedPrompt = {
  text: string;
  name: string;
  version: number;
  id: string | null;
};

type LangfuseTextPrompt = {
  id?: string;
  name: string;
  version: number;
  type: "text";
  prompt: string;
};

const PROMPT_TTL_MS = 5 * 60 * 1000;
const promptMemoryCache = new Map<string, { prompt: LangfuseTextPrompt; expiresAt: number }>();

export function langfuseConfigured(env: LangfuseEnv): boolean {
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

function host(env: LangfuseEnv): string {
  return (env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/$/, "");
}

function authHeader(env: LangfuseEnv): string {
  return `Basic ${btoa(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`)}`;
}

/** Compile Langfuse text-prompt variables strictly, so a missing value never reaches a model. */
export function compilePrompt(template: string, variables: Record<string, string>): string {
  for (const name of Object.keys(variables)) {
    if (!/^[A-Za-z_]+$/.test(name)) throw new Error(`langfuse_prompt_invalid_variable:${name}`);
  }
  const required = new Set(Array.from(template.matchAll(/{{\s*([A-Za-z_]+)\s*}}/g), (match) => match[1]));
  const missing = [...required].filter((name) => !(name in variables));
  if (missing.length) throw new Error(`langfuse_prompt_missing_variables:${missing.join(",")}`);
  const withoutEmptyLines = template.replace(
    /^[\t ]*{{\s*([A-Za-z_]+)\s*}}[\t ]*(?:\r?\n|$)/gm,
    (line, name: string) => variables[name] === "" ? "" : line,
  );
  const compiled = withoutEmptyLines.replace(/{{\s*([A-Za-z_]+)\s*}}/g, (_, name: string) => variables[name]);
  if (/{{[^{}]+}}/.test(compiled)) throw new Error("langfuse_prompt_unresolved_variable");
  return compiled;
}

async function readCachedPrompt(env: LangfuseEnv, name: string): Promise<LangfuseTextPrompt | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT prompt_json FROM langfuse_prompt_cache WHERE prompt_name = ?",
    ).bind(name).first<{ prompt_json: string }>();
    return row?.prompt_json ? JSON.parse(row.prompt_json) as LangfuseTextPrompt : null;
  } catch {
    return null;
  }
}

async function writeCachedPrompt(env: LangfuseEnv, prompt: LangfuseTextPrompt): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO langfuse_prompt_cache (prompt_name, prompt_json, fetched_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(prompt_name) DO UPDATE SET prompt_json = excluded.prompt_json, fetched_at = CURRENT_TIMESTAMP`,
    ).bind(prompt.name, JSON.stringify(prompt)).run();
  } catch {
    // A cache migration lag must not hide a successfully fetched production prompt.
  }
}

/**
 * Whether a fetched template is current enough to use for the code calling it.
 *
 * A Langfuse template that never mentions a newly added variable still compiles cleanly --
 * `compilePrompt` only fails in the other direction, on a variable the template wants and the code
 * doesn't supply. That asymmetry means a release which changes a prompt's contract (new
 * structured-output schema, new inputs) would otherwise run silently against the *old* production
 * prompt: the model is told to do the old task while the schema forces the new shape, and nothing
 * errors. Requiring at least one of the new contract's variables to appear is a cheap, specific
 * test for "this template predates the current code" that no valid updated prompt can fail.
 */
function isPromptCompatible(template: string, requires: string[]): boolean {
  if (!requires.length) return true;
  return requires.some((name) => new RegExp(`{{\\s*${name}\\s*}}`).test(template));
}

/**
 * Fetches the production-labeled Langfuse prompt, with an isolate cache and a persistent D1
 * last-known-good fallback. Prompt bodies therefore have one source of truth without making a
 * temporary Langfuse outage break an already-running installation.
 *
 * When `fallback` is supplied, a bundled repo-side default (see src/prompts.ts) covers the two
 * cases Langfuse cannot: no prompt reachable at all, and a reachable prompt that is too old for the
 * calling code. Langfuse still wins whenever it holds a compatible version, so this does not move
 * prompt ownership back into the repository -- it only stops a schema change from having to be
 * deployed and promoted in the same instant to avoid a silent mismatch.
 */
export async function getManagedPrompt(
  env: LangfuseEnv,
  name: string,
  variables: Record<string, string>,
  fallback?: { text: string; requires: string[] },
): Promise<ManagedPrompt> {
  const key = `${host(env)}:${env.LANGFUSE_PUBLIC_KEY ?? ""}:${name}`;
  const memory = promptMemoryCache.get(key);
  let managed = memory && memory.expiresAt > Date.now() ? memory.prompt : null;
  let fetchError: Error | null = null;

  if (!managed && langfuseConfigured(env)) {
    try {
      const res = await fetch(`${host(env)}/api/public/v2/prompts/${encodeURIComponent(name)}?label=production`, {
        headers: { authorization: authHeader(env) },
      });
      if (!res.ok) throw new Error(`langfuse_prompt_fetch_${res.status}:${name}`);
      const value = await res.json() as LangfuseTextPrompt;
      if (value.type !== "text" || typeof value.prompt !== "string") {
        throw new Error(`langfuse_prompt_wrong_type:${name}`);
      }
      managed = value;
      promptMemoryCache.set(key, { prompt: value, expiresAt: Date.now() + PROMPT_TTL_MS });
      await writeCachedPrompt(env, value);
    } catch (err) {
      fetchError = err as Error;
    }
  }

  if (!managed) managed = await readCachedPrompt(env, name);

  // Checked against the D1 last-known-good copy too, not just a fresh fetch: a stale cached prompt
  // is exactly as incompatible as a stale live one, and this is the "cannot leave an old prompt
  // version active" guarantee the schema change depends on.
  if (fallback && (!managed || !isPromptCompatible(managed.prompt, fallback.requires))) {
    return {
      text: compilePrompt(fallback.text, variables),
      name: `${name} (bundled default)`,
      version: 0,
      id: null,
    };
  }

  if (!managed) {
    throw fetchError ?? new Error(`langfuse_prompt_unavailable:${name}`);
  }
  return {
    text: compilePrompt(managed.prompt, variables),
    name: managed.name,
    version: managed.version,
    id: managed.id ?? null,
  };
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
  if (trace.promptName) attributes.push(attribute("langfuse.observation.prompt.name", trace.promptName));
  if (trace.promptVersion != null) attributes.push(attribute("langfuse.observation.prompt.version", trace.promptVersion));
  if (trace.promptId) attributes.push(attribute("langfuse.observation.prompt.id", trace.promptId));
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
