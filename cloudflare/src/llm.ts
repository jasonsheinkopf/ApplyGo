// Shared model-provider plumbing. Everything that talks to Anthropic or OpenAI goes
// through here so prompts elsewhere stay about content, not transport.
//
// This is also the single choke point every model call passes through, which is why tracing lives
// here rather than at the call sites: there is exactly one place to instrument, and a new call site
// cannot forget to opt in. Each call records what was sent, what came back, what it cost, and how
// long it took, so the prompts can be inspected and compared rather than guessed at.

export interface LlmEnv {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_MODEL?: string;
  ANTHROPIC_SCREEN_MODEL?: string;
  OPENAI_SCREEN_MODEL?: string;
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
  response: string;
  inputTokens: number;
  outputTokens: number;
  /** Null when the model has no entry in PRICING -- an unknown price is not the same as free. */
  costUsd: number | null;
  latencyMs: number;
  ok: boolean;
  error: string | null;
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
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  // Sonnet 5 is running an introductory rate that expires at the end of August 2026. Encoding both
  // means the dashboard reports what was actually spent on each side of that date instead of
  // overstating today's calls by 50%.
  "claude-sonnet-5": { in: 3, out: 15, introIn: 2, introOut: 10, introUntil: "2026-08-31" },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-fable-5": { in: 10, out: 50 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
};

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
 */
async function record(env: LlmEnv, trace: LlmTrace): Promise<void> {
  if (!env.LLM_TRACE_SINK) return;
  try {
    await env.LLM_TRACE_SINK(trace);
  } catch {
    // Deliberately swallowed.
  }
}

/** Wraps one call in timing, token accounting, and trace emission -- including on the error path. */
async function traced<T>(
  env: LlmEnv,
  meta: { task: string; provider: Provider; model: string; tier: Tier; prompt: string },
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
 * Shared writing rules for every prompt whose output a human actually reads.
 *
 * The em dash is the single most recognizable tell that text was machine-written, and a resume or
 * cover letter that reads as AI-generated is worse than one that reads as merely plain. Ordinary
 * hyphens in real compound terms are left alone: "full-stack" and "end-to-end" are how those words
 * are spelled, and removing the hyphen would look wrong to a recruiter rather than natural.
 *
 * The banned-phrase list is not exhaustive and isn't meant to be. It names the specific tics that
 * show up most often, which is enough to push the model's register away from them generally.
 */
export const WRITING_STYLE_RULES = `
WRITING STYLE (applies to every word you produce):
- NEVER use an em dash (—) or an en dash (–). Not once. Where you would reach for one, use a period
  and start a new sentence, or a comma, or parentheses, or a colon. This is the single most common
  giveaway that writing was machine-generated, and it must not appear.
- Ordinary hyphens inside genuine compound terms are correct and expected: "full-stack",
  "end-to-end", "data-driven", "cross-functional". Keep those exactly as they are normally spelled.
- Do not use: "delve", "leverage" as a verb, "robust", "seamless", "spearheaded", "passionate about",
  "proven track record", "tapestry", "testament to", "in today's fast-paced world", "it's worth
  noting". These read as filler.
- Write plainly and concretely. Prefer the specific noun over the abstract one. State things directly
  rather than hedging with "helped to", "worked to", or "was involved in".
- Vary sentence length, and do not open consecutive sentences with the same word or structure.
- No exclamation marks.
`.trim();

/**
 * Which class of model to use. "screen" is the cheap, high-volume tier used for bulk yes/no
 * passes; "reason" is the strong tier used where the answer actually has to be right.
 */
export type Tier = "reason" | "screen";

function modelFor(env: LlmEnv, provider: Provider, tier: Tier): string {
  if (provider === "openai") {
    return tier === "screen" ? env.OPENAI_SCREEN_MODEL || "gpt-4o-mini" : env.OPENAI_MODEL || "gpt-4o";
  }
  return tier === "screen"
    ? env.ANTHROPIC_SCREEN_MODEL || "claude-haiku-4-5-20251001"
    : env.ANTHROPIC_MODEL || "claude-sonnet-5";
}

export function normalizeProvider(value: unknown): Provider {
  return value === "openai" ? "openai" : "anthropic";
}

/** Returns an error response code if the chosen provider has no key configured. */
export function providerKeyMissing(env: LlmEnv, provider: Provider): string | null {
  if (provider === "anthropic" && !env.ANTHROPIC_API_KEY) return "anthropic_not_configured";
  if (provider === "openai" && !env.OPENAI_API_KEY) return "openai_not_configured";
  return null;
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
  prompt: string,
): Promise<string> {
  // Free-text calls have always used the reason-tier model directly rather than going through
  // modelFor, so the tier is named explicitly here to keep the trace honest about what ran.
  const model = provider === "openai" ? env.OPENAI_MODEL || "gpt-4o" : env.ANTHROPIC_MODEL || "claude-sonnet-5";

  return traced(env, { task, provider, model, tier: "reason", prompt }, async () => {
    if (provider === "openai") {
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: openaiHeaders(env),
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
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
        messages: [{ role: "user", content: prompt }],
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
export async function callStructured<T>(
  env: LlmEnv,
  provider: Provider,
  task: string,
  prompt: string,
  schema: unknown,
  toolName: string,
  maxTokens = 4000,
  tier: Tier = "reason",
): Promise<T> {
  const model = modelFor(env, provider, tier);

  return traced(env, { task, provider, model, tier, prompt }, async () => {
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
            { role: "user", content: prompt },
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
        messages: [{ role: "user", content: prompt }],
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

/** Same contract as callStructured, with a JPEG image prepended to the user turn. */
export async function callStructuredWithImage<T>(
  env: LlmEnv,
  provider: Provider,
  task: string,
  prompt: string,
  jpegBase64: string,
  schema: unknown,
  toolName: string,
  maxTokens = 4000,
): Promise<T> {
  const model = provider === "openai" ? env.OPENAI_MODEL || "gpt-4o" : env.ANTHROPIC_MODEL || "claude-sonnet-5";
  // The image itself is not stored on the trace -- a base64 screenshot would dwarf every other
  // record in the table. The prompt is noted as carrying one so the trace isn't misread as the
  // whole input.
  const tracedPrompt = `[+ 1 JPEG screenshot, ${Math.round(jpegBase64.length / 1365)}KB]\n\n${prompt}`;

  return traced(env, { task, provider, model, tier: "reason", prompt: tracedPrompt }, async () => {
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
                { type: "text", text: prompt },
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
              { type: "text", text: prompt },
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
