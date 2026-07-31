// Shared model-provider plumbing. Everything that talks to Anthropic or OpenAI goes
// through here so prompts elsewhere stay about content, not transport.

export interface LlmEnv {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_MODEL?: string;
}

export type Provider = "anthropic" | "openai";

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

export async function callText(env: LlmEnv, provider: Provider, prompt: string): Promise<string> {
  if (provider === "openai") {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: openaiHeaders(env),
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-4o",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw await failure(provider, res);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return (data.choices[0]?.message?.content ?? "").trim();
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: anthropicHeaders(env),
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw await failure(provider, res);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
}

/**
 * Structured output against a caller-supplied JSON Schema. Anthropic gets forced tool use;
 * OpenAI gets JSON mode plus the schema inlined as a system message, since it has no
 * equivalent of `tool_choice` for an arbitrary schema on this endpoint.
 */
export async function callStructured<T>(
  env: LlmEnv,
  provider: Provider,
  prompt: string,
  schema: unknown,
  toolName: string,
  maxTokens = 4000,
): Promise<T> {
  if (provider === "openai") {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: openaiHeaders(env),
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-4o",
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
    return JSON.parse(data.choices[0]?.message?.content ?? "{}") as T;
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: anthropicHeaders(env),
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
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
  return toolUse.input;
}

/** Same contract as callStructured, with a JPEG image prepended to the user turn. */
export async function callStructuredWithImage<T>(
  env: LlmEnv,
  provider: Provider,
  prompt: string,
  jpegBase64: string,
  schema: unknown,
  toolName: string,
  maxTokens = 4000,
): Promise<T> {
  if (provider === "openai") {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: openaiHeaders(env),
      body: JSON.stringify({
        model: env.OPENAI_MODEL || "gpt-4o",
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
    return JSON.parse(data.choices[0]?.message?.content ?? "{}") as T;
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: anthropicHeaders(env),
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
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
  return toolUse.input;
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
