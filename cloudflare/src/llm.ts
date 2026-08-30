// Shared model-provider plumbing. Everything that talks to Anthropic or OpenAI goes
// through here so prompts elsewhere stay about content, not transport.
//
// This is also the single choke point every model call passes through, which is why tracing lives
// here rather than at the call sites: there is exactly one place to instrument, and a new call site
// cannot forget to opt in. Each call records what was sent, what came back, what it cost, and how
// long it took, so the prompts can be inspected and compared rather than guessed at. It's also why
// Langfuse (see langfuse.ts) is wired in here instead of in the D1 trace sink downstream -- every
// call gets a Langfuse trace for free, with no per-call-site opt-in possible to forget.

import { type LangfuseEnv, type ManagedPrompt, sendToLangfuse } from "./langfuse.ts";

export interface LlmEnv extends LangfuseEnv {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_MODEL?: string;
  ANTHROPIC_SCREEN_MODEL?: string;
  OPENAI_SCREEN_MODEL?: string;
  /** Provider for the cheap screen tier only. Unset means "same as whatever is running the job". */
  SCREEN_PROVIDER?: string;
  /**
   * Where completed calls get recorded. Populated once per request by the router; left unset in
   * tests and whenever tracing is switched off, in which case every call runs untraced.
   */
  LLM_TRACE_SINK?: TraceSink;
}

export type Provider = "anthropic" | "openai";

/** One completed model call, successful or not. */
export type LlmTrace = {
  task: string;
  provider: Provider;
  model: string;
  tier: Tier;
  prompt: string;
  promptName: string | null;
  promptVersion: number | null;
  promptId: string | null;
  response: string;
  inputTokens: number;
  outputTokens: number;
  /** Null when the model has no entry in PRICING -- an unknown price is not the same as free. */
  costUsd: number | null;
  latencyMs: number;
  ok: boolean;
  error: string | null;
  /** Set when this call was also sent to Langfuse -- lets the D1 trace sink store the link. */
  langfuseTraceId: string | null;
};

export type TraceSink = (trace: LlmTrace) => Promise<void>;

/**
 * Published list prices in USD per million tokens.
 *
 * Deliberately not a lookup with a default: a model missing from this table records a null cost
 * rather than a zero, because silently pricing an unknown model at $0 makes a cost dashboard worse
 * than having none at all. The dev console surfaces unpriced models so they can be added here.
 *
 * Anthropic figures verified 2026-08-07. OpenAI figures are the published rates for these two
 * models and should be re-checked against OpenAI's pricing page before being trusted for anything
 * beyond rough comparison.
 */
type Price = {
  in: number;
  out: number;
  /** Promotional rate, applied to calls made on or before `introUntil`. */
  introIn?: number;
  introOut?: number;
  introUntil?: string;
};

const PRICING: Record<string, Price> = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-mythos-5": { in: 10, out: 50 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-opus-4-5": { in: 5, out: 25 },
  // Sonnet 5 was launched on an introductory $2/$10 rate advertised as expiring 31 August 2026,
  // and this table encoded the scheduled step up to $3/$15 so that spend either side of that date
  // was reported honestly. Anthropic has since confirmed the introductory rate is now the standard
  // price and the increase will not happen, so the schedule is removed rather than left to fire.
  // Had it stayed, every Sonnet call from 1 September would have been costed 50% high -- silently,
  // because an overstatement looks exactly like a real one on a dashboard.
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  // The GPT-5.6 family (Sol/Terra/Luna), generally available 9 July 2026. Terra is the reason
  // tier's fallback: a generation newer than gpt-4o and cheaper on input, which makes the
  // Anthropic-outage path a smaller quality drop than it was. Rates checked against OpenAI's
  // published pricing 29 August 2026 -- re-check before trusting them for billing rather than
  // comparison, per this table's note above.
  "gpt-5.6-sol": { in: 5, out: 30 },
  "gpt-5.6-terra": { in: 2, out: 12 },
  "gpt-5.6-luna": { in: 0.2, out: 1.2 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
};

/**
 * Reads the array out of a structured `{ results: [...] }` tool response, tolerating the one shape
 * models reliably get wrong.
 *
 * A tool schema declaring an array of objects is usually honoured, but occasionally a model emits
 * the array *as a JSON string* instead -- `{"results":"[{\"id\":...}]"}` rather than
 * `{"results":[{"id":...}]}`. The payload is complete and correct; only the encoding is wrong.
 *
 * Observed in production on a batch of eight job assessments: the caller did `results.map(...)`,
 * threw `results.map is not a function`, and discarded all eight finished assessments along with
 * the tokens spent producing them. Parsing the string recovers the entire batch. Anything that is
 * neither an array nor a string parsing to one yields an empty array, so a genuinely malformed
 * response still degrades to the caller's own missing-result handling rather than crashing.
 */
export function resultsArray<T>(payload: { results?: unknown } | null | undefined): T[] {
  const raw = payload?.results;
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as T[];
    } catch {
      // Falls through to the empty array below -- an unparseable string is a malformed response,
      // not a recoverable encoding slip.
    }
  }
  return [];
}

/** Strips a trailing date snapshot so `claude-haiku-4-5-20251001` prices as `claude-haiku-4-5`. */
function priceKey(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

export function priceFor(model: string): Price | null {
  return PRICING[priceKey(model)] ?? null;
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  at: Date = new Date(),
): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const intro = price.introUntil && at.toISOString().slice(0, 10) <= price.introUntil;
  const inRate = intro ? (price.introIn ?? price.in) : price.in;
  const outRate = intro ? (price.introOut ?? price.out) : price.out;
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
}

/** Every model in the price table, for the dev console's coverage view. */
export function pricedModels(): { model: string; in: number; out: number }[] {
  return Object.entries(PRICING).map(([model, p]) => ({ model, in: p.in, out: p.out }));
}

/**
 * Records a call, then gets out of the way. Tracing is observability, not business logic, so a
 * failure to write the trace must never turn a working model call into a failed one.
 *
 * Langfuse is sent to unconditionally (sendToLangfuse no-ops when unconfigured), independent of
 * whether a D1 sink is attached -- the two are separate observability backends, not a fallback
 * chain. Langfuse runs first so its trace id, if any, can be folded into what the D1 sink stores,
 * which is what lets the dev console link straight into the matching Langfuse trace.
 */
async function record(env: LlmEnv, trace: Omit<LlmTrace, "langfuseTraceId">): Promise<void> {
  const langfuseTraceId = await sendToLangfuse(env, trace);
  if (!env.LLM_TRACE_SINK) return;
  try {
    await env.LLM_TRACE_SINK({ ...trace, langfuseTraceId });
  } catch {
    // Deliberately swallowed.
  }
}

/** Wraps one call in timing, token accounting, and trace emission -- including on the error path. */
async function traced<T>(
  env: LlmEnv,
  meta: Pick<LlmTrace, "task" | "provider" | "model" | "tier" | "prompt" | "promptName" | "promptVersion" | "promptId">,
  run: () => Promise<{ value: T; response: string; inputTokens: number; outputTokens: number }>,
): Promise<T> {
  const started = Date.now();
  try {
    const settled = await run();
    await record(env, {
      ...meta,
      response: settled.response,
      inputTokens: settled.inputTokens,
      outputTokens: settled.outputTokens,
      costUsd: estimateCostUsd(meta.model, settled.inputTokens, settled.outputTokens),
      latencyMs: Date.now() - started,
      ok: true,
      error: null,
    });
    return settled.value;
  } catch (err) {
    await record(env, {
      ...meta,
      response: "",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      latencyMs: Date.now() - started,
      ok: false,
      error: (err as Error).message,
    });
    throw err;
  }
}

type PromptInput = string | ManagedPrompt;

function promptMeta(prompt: PromptInput): Pick<LlmTrace, "prompt" | "promptName" | "promptVersion" | "promptId"> {
  return typeof prompt === "string"
    ? { prompt, promptName: null, promptVersion: null, promptId: null }
    : { prompt: prompt.text, promptName: prompt.name, promptVersion: prompt.version, promptId: prompt.id };
}

type Usage = { inputTokens: number; outputTokens: number };

function anthropicUsage(data: unknown): Usage {
  const usage = (data as { usage?: { input_tokens?: number; output_tokens?: number } })?.usage;
  return { inputTokens: Number(usage?.input_tokens ?? 0), outputTokens: Number(usage?.output_tokens ?? 0) };
}

function openaiUsage(data: unknown): Usage {
  const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
  return { inputTokens: Number(usage?.prompt_tokens ?? 0), outputTokens: Number(usage?.completion_tokens ?? 0) };
}

/**
 * Which class of model to use. "screen" is the cheap, high-volume tier used for bulk yes/no
 * passes; "reason" is the strong tier used where the answer actually has to be right.
 */
export type Tier = "reason" | "screen";

export function modelFor(env: LlmEnv, provider: Provider, tier: Tier): string {
  if (provider === "openai") {
    return tier === "screen" ? env.OPENAI_SCREEN_MODEL || "gpt-4o-mini" : env.OPENAI_MODEL || "gpt-5.6-terra";
  }
  return tier === "screen"
    ? env.ANTHROPIC_SCREEN_MODEL || "claude-haiku-4-5-20251001"
    : env.ANTHROPIC_MODEL || "claude-sonnet-5";
}

export function normalizeProvider(value: unknown): Provider {
  return value === "openai" ? "openai" : "anthropic";
}

/**
 * Which provider runs the cheap screen tier, which need not be the one running the rest of a job.
 *
 * The two tiers do genuinely different work, and the price gap between them is not small. Measured
 * over real batches: a screen call costs $0.0161 on Haiku against $0.0021 on gpt-4o-mini, roughly
 * eight times, for what is a yes/no keep decision made on a job title. Deep assessment is where
 * model quality actually changes the answer and keeps the reasoning model; screening goes wherever
 * it is cheapest.
 *
 * Falls back to the run's own provider whenever SCREEN_PROVIDER is unset or names a provider whose
 * key isn't configured, so a deployment holding only one API key keeps working rather than failing
 * half a pipeline on a config value nobody set.
 */
export function screenProvider(env: LlmEnv, runProvider: Provider): Provider {
  if (!env.SCREEN_PROVIDER) return runProvider;
  const configured = normalizeProvider(env.SCREEN_PROVIDER);
  return providerKeyMissing(env, configured) ? runProvider : configured;
}

/** Returns an error response code if the chosen provider has no key configured. */
export function providerKeyMissing(env: LlmEnv, provider: Provider): string | null {
  if (provider === "anthropic" && !env.ANTHROPIC_API_KEY) return "anthropic_not_configured";
  if (provider === "openai" && !env.OPENAI_API_KEY) return "openai_not_configured";
  return null;
}

/**
 * Turns a raw thrown error into something a candidate can act on. Without this, a provider
 * failure reaches the dashboard as the literal wire error -- `anthropic_error_400: {"type":
 * "error","error":{"type":"invalid_request_error","message":"Your credit balance is too
 * low..."}}` -- and a Browser Rendering capacity error reaches it as `Unable to create new
 * browser: code: 429: message: Rate limit exceeded`. Neither tells the candidate what to do.
 * Falls back to the original message untouched when nothing recognizable matches, so a genuinely
 * new failure mode is never silently hidden.
 */
export function friendlyMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  const providerMatch = raw.match(/^(anthropic|openai)_error_(\d+):? ?([\s\S]*)$/);
  if (providerMatch) {
    const [, provider, status, body] = providerMatch;
    const label = provider === "anthropic" ? "Anthropic" : "OpenAI";
    const billingUrl = provider === "anthropic" ? "console.anthropic.com/settings/billing" : "platform.openai.com/settings/billing";
    let detail = "";
    let errorType = "";
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.error?.message || parsed?.message || "";
      errorType = parsed?.error?.type || parsed?.type || "";
    } catch {
      // Body wasn't JSON -- a truncated blob or a non-JSON error page. Fall through with no detail.
    }
    if (/credit balance is too low/i.test(detail) || /insufficient_quota/i.test(errorType)) {
      return `${label} is out of credits. Add credits at ${billingUrl}, then try again.`;
    }
    if (status === "429" || /rate.?limit/i.test(detail) || /rate.?limit/i.test(errorType)) {
      return `${label} is rate-limiting requests right now. Wait a bit and try again.`;
    }
    if (status === "401" || status === "403") {
      return `${label} rejected the API key. Check the key in Settings, then try again.`;
    }
    if (status === "529" || status === "503") {
      return `${label} is temporarily overloaded. Wait a bit and try again.`;
    }
    return detail ? `${label} error: ${detail}` : raw;
  }

  if (/unable to create new browser/i.test(raw) && /(429|rate limit)/i.test(raw)) {
    return "Too many resume previews are rendering right now. Wait about 30 seconds and try again.";
  }

  return raw;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

function anthropicHeaders(env: LlmEnv): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY!,
    "anthropic-version": "2023-06-01",
  };
}

function openaiHeaders(env: LlmEnv): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` };
}

/** Surfaces the provider's own error body, which is far more useful than a bare status code. */
async function failure(provider: Provider, res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`${provider}_error_${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
}

export async function callText(
  env: LlmEnv,
  provider: Provider,
  task: string,
  prompt: PromptInput,
  /** Bypasses the configured model entirely. Only the eval harness sets this. */
  modelOverride?: string,
): Promise<string> {
  // Free-text calls use the reason-tier model, and say so explicitly so the trace is honest about
  // what ran. Resolved through modelFor rather than repeating the defaults inline: three copies of
  // "which model do we use when nothing is configured" is three places to forget when one changes,
  // and this file had exactly that until the fallback model was upgraded.
  const model = modelOverride ?? modelFor(env, provider, "reason");

  const meta = promptMeta(prompt);
  return traced(env, { task, provider, model, tier: "reason", ...meta }, async () => {
    if (provider === "openai") {
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: openaiHeaders(env),
        body: JSON.stringify({ model, messages: [{ role: "user", content: meta.prompt }] }),
      });
      if (!res.ok) throw await failure(provider, res);
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      const value = (data.choices[0]?.message?.content ?? "").trim();
      return { value, response: value, ...openaiUsage(data) };
    }

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicHeaders(env),
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        messages: [{ role: "user", content: meta.prompt }],
      }),
    });
    if (!res.ok) throw await failure(provider, res);
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    const value = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
    return { value, response: value, ...anthropicUsage(data) };
  });
}

/**
 * Structured output against a caller-supplied JSON Schema. Anthropic gets forced tool use;
 * OpenAI gets JSON mode plus the schema inlined as a system message, since it has no
 * equivalent of `tool_choice` for an arbitrary schema on this endpoint.
 */
/**
 * How much deliberation a call gets before answering.
 *
 * Deliberately coarse. The pipeline has exactly two regimes: bulk calls where the answer is a cheap
 * classification and thinking buys nothing, and the handful of calls where a better answer is the
 * product -- building a reference ranking, adjudicating a disagreement. A dial with five settings
 * would invite tuning that no measurement supports.
 */
export type Effort = "none" | "low" | "medium" | "high";

/**
 * Thinking budget in tokens, per effort level.
 *
 * These are budgets, not targets: a model that reaches its answer sooner stops, and the unused
 * budget is not billed. The high tier is sized for a task that has to hold ~25 postings and a full
 * candidate profile in mind at once and produce a defensible ordering across all of them.
 */
export function thinkingBudget(effort: Effort): number {
  if (effort === "high") return 16000;
  if (effort === "medium") return 6000;
  if (effort === "low") return 2000;
  return 0;
}

export async function callStructured<T>(
  env: LlmEnv,
  provider: Provider,
  task: string,
  prompt: PromptInput,
  schema: unknown,
  toolName: string,
  maxTokens = 4000,
  tier: Tier = "reason",
  /** Bypasses the configured model entirely. Only the eval harness sets this. */
  modelOverride?: string,
  /**
   * Extra deliberation before answering, for the small number of calls where the answer is worth
   * more than the tokens. Off by default: the pipeline's bulk calls are cheap classification where
   * thinking buys nothing, and paying for it on every posting would be the whole cost saving
   * thrown away. Reserved for building a reference ranking, where a better answer is the product.
   */
  effort?: Effort,
): Promise<T> {
  const model = modelOverride ?? modelFor(env, provider, tier);

  const meta = promptMeta(prompt);
  return traced(env, { task, provider, model, tier, ...meta }, async () => {
    if (provider === "openai") {
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: openaiHeaders(env),
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          ...(effort && effort !== "none" ? { reasoning_effort: effort } : {}),
          messages: [
            {
              role: "system",
              content:
                "Respond with a single JSON object only, no prose outside it. It must validate " +
                `against this JSON Schema:\n${JSON.stringify(schema)}`,
            },
            { role: "user", content: meta.prompt },
          ],
        }),
      });
      if (!res.ok) throw await failure(provider, res);
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      const raw = data.choices[0]?.message?.content ?? "{}";
      return { value: JSON.parse(raw) as T, response: raw, ...openaiUsage(data) };
    }

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicHeaders(env),
      body: JSON.stringify({
        model,
        // Thinking tokens are drawn from max_tokens, so a budget must leave room for the answer
        // itself. Without this the call returns a truncated tool payload, which the caller sees as
        // a malformed response rather than as "the budget was spent thinking".
        max_tokens: effort && effort !== "none" ? maxTokens + thinkingBudget(effort) : maxTokens,
        messages: [{ role: "user", content: meta.prompt }],
        tools: [{ name: toolName, input_schema: schema }],
        // A forced tool choice is incompatible with extended thinking, so a thinking call asks for
        // the tool rather than requiring it. resultsArray and the caller's missing-result handling
        // already cover a response that arrives in another shape.
        ...(effort && effort !== "none"
          ? { thinking: { type: "enabled", budget_tokens: thinkingBudget(effort) }, tool_choice: { type: "auto" } }
          : { tool_choice: { type: "tool", name: toolName } }),
      }),
    });
    if (!res.ok) throw await failure(provider, res);
    const data = (await res.json()) as { content: { type: string; input?: T }[] };
    const toolUse = data.content.find((b) => b.type === "tool_use");
    if (!toolUse?.input) throw new Error("anthropic_no_structured_output");
    return {
      value: toolUse.input,
      response: JSON.stringify(toolUse.input),
      ...anthropicUsage(data),
    };
  });
}

/**
 * Structured output grounded in Claude's own server-side web search, for the one class of question
 * plain model memory can't honestly answer: something that depends on current, real information
 * (e.g. "what is this specific company's real website"). Anthropic-only -- there is no equivalent
 * concept for OpenAI's chat completions endpoint wired into this app, and the caller is responsible
 * for checking `providerKeyMissing(env, "anthropic")` first and treating this capability as simply
 * unavailable rather than an error when it's unset.
 *
 * Deliberately does not force tool_choice the way callStructured does: the model has to be free to
 * call `web_search` first (Anthropic runs the search server-side and continues the same turn with
 * real results in context), then call the caller's own structured tool once it has an answer.
 * `tool_choice` stays "auto" so both remain available; the prompt itself is what tells the model to
 * finish by calling the structured tool. If it never does -- it answered in plain text instead, or
 * gave up -- this throws `anthropic_no_search_result` rather than inventing a fallback value, so a
 * caller can treat "the model didn't commit to an answer" as exactly as unresolved as "it found
 * nothing," never as a result to trust.
 *
 * Cost note: Anthropic bills a small additional per-search fee on top of normal token cost, which
 * estimateCostUsd (token-only) doesn't account for -- the Cost tab will slightly undercount calls
 * that used web_search. Not worth modeling precisely for how rarely this path runs.
 */
export async function callWithWebSearch<T>(
  env: LlmEnv,
  task: string,
  prompt: PromptInput,
  schema: unknown,
  toolName: string,
  maxTokens = 1500,
  maxSearches = 3,
): Promise<T> {
  const model = modelFor(env, "anthropic", "reason");
  const meta = promptMeta(prompt);
  return traced(env, { task, provider: "anthropic", model, tier: "reason", ...meta }, async () => {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicHeaders(env),
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: meta.prompt }],
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: maxSearches },
          { name: toolName, input_schema: schema },
        ],
      }),
    });
    if (!res.ok) throw await failure("anthropic", res);
    const data = (await res.json()) as { content: { type: string; name?: string; input?: T }[] };
    // The model may call web_search (and Anthropic may inject its own result blocks) any number of
    // times before finally calling the structured tool -- only the LAST tool_use block named
    // `toolName` is the real answer; anything named "web_search" is the model's own search query,
    // not a result to parse as T.
    const toolUse = [...data.content].reverse().find((b) => b.type === "tool_use" && b.name === toolName);
    if (!toolUse?.input) throw new Error("anthropic_no_search_result");
    return { value: toolUse.input, response: JSON.stringify(toolUse.input), ...anthropicUsage(data) };
  });
}

/** Same contract as callStructured, with a JPEG image prepended to the user turn. */
export async function callStructuredWithImage<T>(
  env: LlmEnv,
  provider: Provider,
  task: string,
  prompt: PromptInput,
  jpegBase64: string,
  schema: unknown,
  toolName: string,
  maxTokens = 4000,
): Promise<T> {
  const model = modelFor(env, provider, "reason");
  // The image itself is not stored on the trace -- a base64 screenshot would dwarf every other
  // record in the table. The prompt is noted as carrying one so the trace isn't misread as the
  // whole input.
  const meta = promptMeta(prompt);
  const tracedPrompt = `[+ 1 JPEG screenshot, ${Math.round(jpegBase64.length / 1365)}KB]\n\n${meta.prompt}`;

  return traced(env, { task, provider, model, tier: "reason", ...meta, prompt: tracedPrompt }, async () => {
    if (provider === "openai") {
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: openaiHeaders(env),
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "Respond with a single JSON object only, no prose outside it. It must validate " +
                `against this JSON Schema:\n${JSON.stringify(schema)}`,
            },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } },
                { type: "text", text: meta.prompt },
              ],
            },
          ],
        }),
      });
      if (!res.ok) throw await failure(provider, res);
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      const raw = data.choices[0]?.message?.content ?? "{}";
      return { value: JSON.parse(raw) as T, response: raw, ...openaiUsage(data) };
    }

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicHeaders(env),
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpegBase64 } },
              { type: "text", text: meta.prompt },
            ],
          },
        ],
        tools: [{ name: toolName, input_schema: schema }],
        tool_choice: { type: "tool", name: toolName },
      }),
    });
    if (!res.ok) throw await failure(provider, res);
    const data = (await res.json()) as { content: { type: string; input?: T }[] };
    const toolUse = data.content.find((b) => b.type === "tool_use");
    if (!toolUse?.input) throw new Error("anthropic_no_structured_output");
    return {
      value: toolUse.input,
      response: JSON.stringify(toolUse.input),
      ...anthropicUsage(data),
    };
  });
}

/** btoa() on a whole screenshot blows the argument limit, so chunk it. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
