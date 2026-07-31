import { extractText, getDocumentProxy } from "unpdf";

interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  SETUP_SECRET: string;
  SESSION_DAYS: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_MODEL?: string;
}

type Session = {
  id: string;
  device_name: string;
  expires_at: string;
  revoked_at: string | null;
};

const encoder = new TextEncoder();

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function digestHex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  return digestHex(encoder.encode(value));
}

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `applygo_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie(): string {
  return "applygo_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

async function requireSession(request: Request, env: Env): Promise<Session | Response> {
  const token = cookieValue(request, "applygo_session");
  if (!token) return json({ error: "authentication_required" }, 401);
  const tokenHash = await sha256(token);
  const session = await env.DB.prepare(
    `SELECT id, device_name, expires_at, revoked_at
     FROM device_sessions
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')`,
  )
    .bind(tokenHash)
    .first<Session>();
  if (!session) return json({ error: "invalid_or_expired_session" }, 401, { "set-cookie": clearSessionCookie() });
  await env.DB.prepare("UPDATE device_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(session.id)
    .run();
  return session;
}

async function createEnrollment(request: Request, env: Env): Promise<Response> {
  if (!env.SETUP_SECRET || request.headers.get("x-applygo-setup-secret") !== env.SETUP_SECRET) {
    return json({ error: "forbidden" }, 403);
  }
  const body = (await request.json().catch(() => ({}))) as { label?: string; minutes?: number };
  const code = randomToken(18);
  const codeHash = await sha256(code);
  const id = crypto.randomUUID();
  const minutes = Math.min(Math.max(body.minutes ?? 15, 1), 60);
  await env.DB.prepare(
    "INSERT INTO enrollment_codes (id, code_hash, label, expires_at) VALUES (?, ?, ?, datetime('now', ?))",
  )
    .bind(id, codeHash, body.label ?? "", `+${minutes} minutes`)
    .run();
  return json({ enrollment_code: code, expires_in_minutes: minutes }, 201);
}

async function exchangeEnrollment(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { code?: string; device_name?: string };
  if (!body.code || !body.device_name) return json({ error: "code_and_device_name_required" }, 400);
  const codeHash = await sha256(body.code);
  const enrollment = await env.DB.prepare(
    `SELECT id FROM enrollment_codes
     WHERE code_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`,
  )
    .bind(codeHash)
    .first<{ id: string }>();
  if (!enrollment) return json({ error: "invalid_or_expired_enrollment" }, 401);

  const token = randomToken();
  const tokenHash = await sha256(token);
  const sessionId = crypto.randomUUID();
  const days = Math.min(Math.max(Number(env.SESSION_DAYS || "90"), 1), 365);
  await env.DB.batch([
    env.DB.prepare("UPDATE enrollment_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?").bind(enrollment.id),
    env.DB.prepare(
      "INSERT INTO device_sessions (id, token_hash, device_name, expires_at) VALUES (?, ?, ?, datetime('now', ?))",
    ).bind(sessionId, tokenHash, body.device_name.slice(0, 120), `+${days} days`),
  ]);
  return json(
    { authenticated: true, device_id: sessionId, expires_in_days: days },
    201,
    { "set-cookie": sessionCookie(token, days * 86400) },
  );
}

async function listDevices(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const devices = await env.DB.prepare(
    `SELECT id, device_name, created_at, last_seen_at, expires_at,
            CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END AS revoked
     FROM device_sessions ORDER BY created_at DESC`,
  ).all();
  return json({ current_device_id: auth.id, devices: devices.results });
}

async function revokeDevice(request: Request, env: Env, deviceId: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const result = await env.DB.prepare(
    "UPDATE device_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL",
  )
    .bind(deviceId)
    .run();
  const headers: HeadersInit = deviceId === auth.id ? { "set-cookie": clearSessionCookie() } : {};
  return json({ revoked: result.meta.changes > 0 }, 200, headers);
}

type Profile = {
  id: string;
  label: string;
  summary: string;
  preferences_json: string;
  structured_json: string;
  created_at: string;
  updated_at: string;
};

type StructuredProfile = {
  headline: string;
  narrative_summary: string;
  education: { school: string; degree: string; field: string; start_year: string; end_year: string }[];
  experience: { company: string; title: string; start: string; end: string; highlights: string[] }[];
  skills: string[];
};

function readDesiredRoles(preferencesJson: string): string {
  try {
    return (JSON.parse(preferencesJson || "{}") as { desired_roles?: string }).desired_roles ?? "";
  } catch {
    return "";
  }
}

function readStructuredProfile(structuredJson: string): StructuredProfile | null {
  try {
    const parsed = JSON.parse(structuredJson || "{}");
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function getProfile(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const profile = await env.DB.prepare(
    "SELECT id, label, summary, preferences_json, structured_json, created_at, updated_at FROM candidate_profiles WHERE id = ?",
  )
    .bind(profileId)
    .first<Profile>();
  return json({
    profile: {
      ...profile,
      desired_roles: readDesiredRoles(profile?.preferences_json ?? "{}"),
      structured: readStructuredProfile(profile?.structured_json ?? "{}"),
    },
  });
}

async function saveStructuredProfile(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { structured?: unknown };
  if (!body.structured || typeof body.structured !== "object") {
    return json({ error: "structured_required" }, 400);
  }
  const structured = body.structured as StructuredProfile;
  const profileId = await getOrCreateProfileId(env);
  await env.DB.prepare(
    "UPDATE candidate_profiles SET structured_json = ?, summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(JSON.stringify(structured), (structured.narrative_summary ?? "").slice(0, 4000), profileId)
    .run();
  return json({ structured });
}

async function saveDesiredRoles(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { desired_roles?: string };
  const desiredRoles = (body.desired_roles ?? "").trim();
  const profileId = await getOrCreateProfileId(env);
  const existing = await env.DB.prepare("SELECT preferences_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ preferences_json: string }>();
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(existing?.preferences_json || "{}");
  } catch {
    prefs = {};
  }
  prefs.desired_roles = desiredRoles;
  await env.DB.prepare("UPDATE candidate_profiles SET preferences_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(JSON.stringify(prefs), profileId)
    .run();
  return json({ desired_roles: desiredRoles });
}

async function listRoleSignals(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const rows = await env.DB.prepare(
    "SELECT id, claim, created_at FROM candidate_evidence WHERE profile_id = ? AND category = 'role_signal' ORDER BY created_at DESC",
  )
    .bind(profileId)
    .all();
  return json({ role_signals: rows.results });
}

async function createRoleSignal(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { text?: string };
  const claim = (body.text ?? "").trim();
  if (!claim) return json({ error: "text_required" }, 400);
  const profileId = await getOrCreateProfileId(env);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO candidate_evidence (id, profile_id, category, claim, usable_in_applications) VALUES (?, ?, 'role_signal', ?, 1)",
  )
    .bind(id, profileId, claim)
    .run();
  return json({ id, claim }, 201);
}

async function deleteRoleSignal(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const result = await env.DB.prepare("DELETE FROM candidate_evidence WHERE id = ? AND category = 'role_signal'")
    .bind(id)
    .run();
  return json({ deleted: result.meta.changes > 0 });
}

async function generateDesiredRoles(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { provider?: string };
  const provider = body.provider === "openai" ? "openai" : "anthropic";
  if (provider === "anthropic" && !env.ANTHROPIC_API_KEY) return json({ error: "anthropic_not_configured" }, 501);
  if (provider === "openai" && !env.OPENAI_API_KEY) return json({ error: "openai_not_configured" }, 501);

  const profileId = await getOrCreateProfileId(env);
  const signals = await env.DB.prepare(
    "SELECT claim FROM candidate_evidence WHERE profile_id = ? AND category = 'role_signal' ORDER BY created_at ASC",
  )
    .bind(profileId)
    .all<{ claim: string }>();
  if (signals.results.length === 0) return json({ error: "no_source_material" }, 400);

  const prompt = [
    "A job candidate has given you loose notes, job links, and preferences about the kind of roles they want next.",
    "Write a clear, structured description of the roles they are looking for: role families/titles, seniority, domain,",
    "must-have vs nice-to-have aspects, and anything they explicitly ruled out. Base this only on the notes below.",
    "",
    "Notes:",
    ...signals.results.map((s) => `- ${s.claim}`),
  ].join("\n\n");

  try {
    const draft = provider === "openai" ? await callOpenAI(env, prompt) : await callAnthropic(env, prompt);
    return json({ provider, draft_description: draft });
  } catch (err) {
    return json({ error: "generation_failed", detail: (err as Error).message }, 502);
  }
}

async function upsertProfile(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { label?: string };
  const label = (body.label ?? "").trim();
  if (!label) return json({ error: "label_required" }, 400);
  const profileId = await getOrCreateProfileId(env);
  await env.DB.prepare("UPDATE candidate_profiles SET label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(label, profileId)
    .run();
  return json({ id: profileId, label });
}

type JobPosting = {
  id: string;
  title: string;
  company: string;
  source_url: string;
  raw_description: string;
  created_at: string;
};

async function listJobs(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const jobs = await env.DB.prepare(
    "SELECT id, title, company, source_url, raw_description, created_at FROM job_postings ORDER BY created_at DESC LIMIT 100",
  ).all<JobPosting>();
  return json({ jobs: jobs.results });
}

async function createJob(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
    company?: string;
    source_url?: string;
    raw_description?: string;
  };
  const title = (body.title ?? "").trim();
  const company = (body.company ?? "").trim();
  const raw_description = (body.raw_description ?? "").trim();
  const source_url = (body.source_url ?? "").trim();
  if (!title || !company || !raw_description) {
    return json({ error: "title_company_and_raw_description_required" }, 400);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO job_postings (id, title, company, source_url, raw_description) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, title, company, source_url, raw_description)
    .run();
  return json({ id, title, company, source_url, raw_description }, 201);
}

async function deleteJob(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const result = await env.DB.prepare("DELETE FROM job_postings WHERE id = ?").bind(id).run();
  return json({ deleted: result.meta.changes > 0 });
}

async function getOrCreateProfileId(env: Env): Promise<string> {
  const existing = await env.DB.prepare(
    "SELECT id FROM candidate_profiles ORDER BY created_at ASC LIMIT 1",
  ).first<{ id: string }>();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO candidate_profiles (id, label, summary) VALUES (?, '', '')").bind(id).run();
  return id;
}

const DOCUMENT_TYPES = new Set(["application/pdf", "text/plain", "text/markdown"]);

async function listDocuments(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const docs = await env.DB.prepare(
    `SELECT id, original_name, media_type, created_at, LENGTH(extracted_text) > 0 AS has_text
     FROM source_documents WHERE profile_id = ? ORDER BY created_at DESC`,
  )
    .bind(profileId)
    .all();
  return json({ documents: docs.results });
}

async function uploadDocument(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "file_required" }, 400);
  if (file.size > 15 * 1024 * 1024) return json({ error: "file_too_large" }, 413);
  if (!DOCUMENT_TYPES.has(file.type)) return json({ error: "unsupported_media_type" }, 415);

  const bytes = await file.arrayBuffer();
  const sha = await digestHex(bytes);
  let extractedText = "";
  if (file.type === "text/plain" || file.type === "text/markdown") {
    extractedText = new TextDecoder().decode(bytes);
  } else if (file.type === "application/pdf") {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      extractedText = text;
    } catch {
      extractedText = "";
    }
  }
  const key = `documents/${crypto.randomUUID()}`;
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: file.type },
    customMetadata: { originalName: file.name, uploadedByDevice: auth.id },
  });

  const profileId = await getOrCreateProfileId(env);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO source_documents (id, profile_id, original_name, r2_key, media_type, sha256, extracted_text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, profileId, file.name, key, file.type, sha, extractedText)
    .run();
  return json({ id, original_name: file.name, media_type: file.type, has_text: extractedText.length > 0 }, 201);
}

async function renameDocument(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { original_name?: string };
  const name = (body.original_name ?? "").trim();
  if (!name) return json({ error: "original_name_required" }, 400);
  await env.DB.prepare("UPDATE source_documents SET original_name = ? WHERE id = ?").bind(name, id).run();
  return json({ id, original_name: name });
}

async function deleteDocument(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const doc = await env.DB.prepare("SELECT r2_key FROM source_documents WHERE id = ?")
    .bind(id)
    .first<{ r2_key: string }>();
  if (!doc) return json({ error: "not_found" }, 404);
  await env.FILES.delete(doc.r2_key);
  await env.DB.prepare("DELETE FROM source_documents WHERE id = ?").bind(id).run();
  return json({ deleted: true });
}

async function listNotes(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profileId = await getOrCreateProfileId(env);
  const notes = await env.DB.prepare(
    "SELECT id, claim, created_at FROM candidate_evidence WHERE profile_id = ? AND category = 'note' ORDER BY created_at DESC",
  )
    .bind(profileId)
    .all();
  return json({ notes: notes.results });
}

async function createNote(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { text?: string };
  const claim = (body.text ?? "").trim();
  if (!claim) return json({ error: "text_required" }, 400);
  const profileId = await getOrCreateProfileId(env);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO candidate_evidence (id, profile_id, category, claim, usable_in_applications) VALUES (?, ?, 'note', ?, 1)",
  )
    .bind(id, profileId, claim)
    .run();
  return json({ id, claim }, 201);
}

async function deleteNote(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const result = await env.DB.prepare("DELETE FROM candidate_evidence WHERE id = ? AND category = 'note'")
    .bind(id)
    .run();
  return json({ deleted: result.meta.changes > 0 });
}

async function callAnthropic(env: Env, prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic_error_${res.status}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  return data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

async function callOpenAI(env: Env, prompt: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4o",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`openai_error_${res.status}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return (data.choices[0]?.message?.content ?? "").trim();
}

const STRUCTURED_PROFILE_JSON_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "A one-line professional headline, e.g. 'Senior AI Engineer'." },
    narrative_summary: { type: "string", description: "A short prose summary, 3-6 sentences, useful for a cover letter." },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          school: { type: "string" },
          degree: { type: "string" },
          field: { type: "string" },
          start_year: { type: "string" },
          end_year: { type: "string" },
        },
        required: ["school"],
      },
    },
    experience: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          highlights: { type: "array", items: { type: "string" } },
        },
        required: ["company", "title"],
      },
    },
    skills: { type: "array", items: { type: "string" } },
  },
  required: ["headline", "narrative_summary", "education", "experience", "skills"],
} as const;

async function callAnthropicStructured(env: Env, prompt: string): Promise<StructuredProfile> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ name: "submit_structured_profile", input_schema: STRUCTURED_PROFILE_JSON_SCHEMA }],
      tool_choice: { type: "tool", name: "submit_structured_profile" },
    }),
  });
  if (!res.ok) throw new Error(`anthropic_error_${res.status}`);
  const data = (await res.json()) as { content: { type: string; input?: StructuredProfile }[] };
  const toolUse = data.content.find((block) => block.type === "tool_use");
  if (!toolUse?.input) throw new Error("anthropic_no_structured_output");
  return toolUse.input;
}

async function callOpenAIStructured(env: Env, prompt: string): Promise<StructuredProfile> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Respond with a single JSON object only, matching this shape: " +
            "{headline: string, narrative_summary: string, education: [{school, degree, field, start_year, end_year}], " +
            "experience: [{company, title, start, end, highlights: string[]}], skills: string[]}. No prose outside the JSON.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai_error_${res.status}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const raw = data.choices[0]?.message?.content ?? "{}";
  return JSON.parse(raw) as StructuredProfile;
}

async function generateProfile(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { provider?: string };
  const provider = body.provider === "openai" ? "openai" : "anthropic";
  if (provider === "anthropic" && !env.ANTHROPIC_API_KEY) return json({ error: "anthropic_not_configured" }, 501);
  if (provider === "openai" && !env.OPENAI_API_KEY) return json({ error: "openai_not_configured" }, 501);

  const profileId = await getOrCreateProfileId(env);
  const profile = await env.DB.prepare("SELECT structured_json FROM candidate_profiles WHERE id = ?")
    .bind(profileId)
    .first<{ structured_json: string }>();
  const notes = await env.DB.prepare(
    "SELECT claim FROM candidate_evidence WHERE profile_id = ? AND category = 'note' ORDER BY created_at ASC",
  )
    .bind(profileId)
    .all<{ claim: string }>();
  const docs = await env.DB.prepare(
    `SELECT original_name, extracted_text FROM source_documents
     WHERE profile_id = ? AND LENGTH(extracted_text) > 0 ORDER BY created_at ASC`,
  )
    .bind(profileId)
    .all<{ original_name: string; extracted_text: string }>();

  const sourceParts: string[] = [];
  const existingStructured = readStructuredProfile(profile?.structured_json ?? "{}");
  if (existingStructured) sourceParts.push(`Existing structured profile:\n${JSON.stringify(existingStructured)}`);
  for (const note of notes.results) sourceParts.push(`Note: ${note.claim}`);
  for (const doc of docs.results) sourceParts.push(`Document "${doc.original_name}":\n${doc.extracted_text.slice(0, 8000)}`);

  if (sourceParts.length === 0) return json({ error: "no_source_material" }, 400);

  const prompt = [
    "You are helping a job candidate build a structured professional profile from their own source material:",
    "education history, work experience with highlights, skills, a headline, and a short narrative summary.",
    "Base this only on the material below. Do not invent schools, employers, dates, or accomplishments that are",
    "not present in the source material. Leave a field empty rather than guessing.",
    "",
    "Source material:",
    ...sourceParts,
  ].join("\n\n");

  try {
    const draft = provider === "openai" ? await callOpenAIStructured(env, prompt) : await callAnthropicStructured(env, prompt);
    return json({ provider, draft_structured: draft });
  } catch (err) {
    return json({ error: "generation_failed", detail: (err as Error).message }, 502);
  }
}

async function uploadArtifact(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "file_required" }, 400);
  if (file.size > 15 * 1024 * 1024) return json({ error: "file_too_large" }, 413);
  const allowed = new Set(["application/pdf", "text/plain", "text/markdown"]);
  if (!allowed.has(file.type)) return json({ error: "unsupported_media_type" }, 415);
  const key = `uploads/${crypto.randomUUID()}`;
  await env.FILES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { originalName: file.name, uploadedByDevice: auth.id },
  });
  return json({ key, name: file.name, media_type: file.type, size: file.size }, 201);
}

const ENROLL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ApplyGo Device Enrollment</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.35rem; }
  label { display: block; margin: 1rem 0 0.25rem; font-weight: 600; }
  input { width: 100%; padding: 0.6rem; font-size: 1rem; box-sizing: border-box; }
  button { margin-top: 1.5rem; padding: 0.7rem 1.25rem; font-size: 1rem; width: 100%; cursor: pointer; }
  #status { margin-top: 1rem; font-weight: 600; min-height: 1.25rem; }
  #status.success { color: #16794e; }
  #status.error { color: #b3261e; }
</style>
</head>
<body>
  <main>
    <h1>Enroll this device</h1>
    <p>Enter the one-time enrollment code and a name for this device. The code is single-use and expires quickly.</p>
    <form id="enroll-form">
      <label for="code">Enrollment code</label>
      <input id="code" name="code" autocomplete="one-time-code" required>
      <label for="device_name">Device name</label>
      <input id="device_name" name="device_name" required placeholder="e.g. Jason's iPhone">
      <button type="submit">Enroll device</button>
    </form>
    <p id="status" role="status" aria-live="polite"></p>
  </main>
  <script>
    var form = document.getElementById('enroll-form');
    var statusEl = document.getElementById('status');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      statusEl.textContent = 'Enrolling…';
      statusEl.className = '';
      var code = document.getElementById('code').value.trim();
      var deviceName = document.getElementById('device_name').value.trim();
      fetch('/auth/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code: code, device_name: deviceName }),
      })
        .then(function (res) {
          if (!res.ok) {
            return res.json().catch(function () { return {}; }).then(function (body) {
              throw new Error(body.error || 'enrollment_failed');
            });
          }
          return fetch('/me', { credentials: 'same-origin' });
        })
        .then(function (meRes) {
          if (!meRes.ok) throw new Error('session_verification_failed');
          statusEl.textContent = 'Device enrolled. Session verified — you can close this page.';
          statusEl.className = 'success';
          form.reset();
        })
        .catch(function (err) {
          statusEl.textContent = 'Enrollment failed: ' + err.message;
          statusEl.className = 'error';
        });
    });
  </script>
</body>
</html>`;

function enrollPage(): Response {
  return new Response(ENROLL_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const DASHBOARD_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ApplyGo</title>
<style>
  :root {
    color-scheme: light dark;
    --accent: #4f46e5;
    --accent-contrast: #ffffff;
    --bg: #f6f6f9;
    --surface: #ffffff;
    --border: #e3e3ea;
    --text: #1a1a1f;
    --text-muted: #6b6b76;
    --success: #16794e;
    --error: #b3261e;
    --radius: 0.85rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101012;
      --surface: #1b1b1f;
      --border: #2d2d33;
      --text: #f1f1f3;
      --text-muted: #9c9ca6;
      --accent: #818cf8;
      --accent-contrast: #101012;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    margin: 0;
    padding-bottom: 3rem;
    line-height: 1.5;
  }
  .shell { max-width: 68rem; margin: 0 auto; padding: 0 1.1rem; }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 1.1rem 0; gap: 0.75rem;
  }
  .brand { display: flex; align-items: center; gap: 0.5rem; font-weight: 700; font-size: 1.15rem; }
  .brand svg { flex: none; }
  .brand .go { color: var(--accent); }
  nav {
    display: flex; gap: 0.35rem; overflow-x: auto; padding-bottom: 0.5rem;
    -webkit-overflow-scrolling: touch; scrollbar-width: none;
  }
  nav::-webkit-scrollbar { display: none; }
  nav button {
    flex: none; margin: 0; padding: 0.5rem 0.9rem; font-size: 0.9rem; font-weight: 600;
    background: none; border: none; border-radius: 999px; color: var(--text-muted); cursor: pointer;
  }
  nav button.active { background: var(--accent); color: var(--accent-contrast); }
  .panel { display: none; }
  .panel.active { display: block; }
  section {
    margin: 1.1rem 0; padding: 1.1rem; background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--radius);
  }
  h2 { font-size: 1.05rem; margin: 0 0 0.75rem; }
  p.hint { color: var(--text-muted); font-size: 0.88rem; margin: -0.25rem 0 0.75rem; }
  label { display: block; margin: 0.75rem 0 0.3rem; font-weight: 600; font-size: 0.88rem; }
  input, textarea, select {
    width: 100%; padding: 0.6rem 0.7rem; font-size: 1rem; box-sizing: border-box; font-family: inherit;
    background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 0.5rem;
  }
  textarea { min-height: 5.5rem; resize: vertical; }
  button {
    margin-top: 1rem; padding: 0.65rem 1.15rem; font-size: 0.95rem; font-weight: 600; cursor: pointer;
    background: var(--accent); color: var(--accent-contrast); border: none; border-radius: 0.5rem;
  }
  button.secondary { background: none; border: 1px solid var(--border); color: var(--text); }
  #sign-out { margin-top: 0; padding: 0.4rem 0.85rem; font-size: 0.85rem; }
  .status { margin-top: 0.6rem; font-weight: 600; font-size: 0.9rem; min-height: 1.1rem; }
  .status.success { color: var(--success); }
  .status.error { color: var(--error); }
  .row-item { padding: 0.75rem 0; border-top: 1px solid var(--border); }
  .row-item:first-child { border-top: none; padding-top: 0; }
  .row-title { font-weight: 600; }
  .row-meta { font-size: 0.85rem; color: var(--text-muted); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .empty { color: var(--text-muted); font-size: 0.9rem; }
  .split { display: grid; grid-template-columns: 1fr; gap: 1.1rem; align-items: start; }
  @media (min-width: 760px) {
    .split { grid-template-columns: 1fr 1fr; }
    .split-sticky { position: sticky; top: 1rem; }
  }
  .collapsible-text { cursor: pointer; }
  h3.subhead { font-size: 0.85rem; margin: 1.1rem 0 0.4rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.03em; }
  .skills-list { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.3rem; }
  .skill-pill { background: var(--bg); border: 1px solid var(--border); border-radius: 999px; padding: 0.2rem 0.65rem; font-size: 0.85rem; }
  hr.divider { border: none; border-top: 1px solid var(--border); margin: 1.25rem 0; }
</style>
</head>
<body>
  <div class="shell">
  <header>
    <div class="brand">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <rect width="28" height="28" rx="8" fill="var(--accent)"/>
        <path d="M8 15L13 20L21 9" stroke="var(--accent-contrast)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Apply<span class="go">Go</span></span>
    </div>
    <button id="sign-out" class="secondary" type="button">Sign out</button>
  </header>

  <nav>
    <button class="tab active" data-tab="roles" type="button">Desired Roles</button>
    <button class="tab" data-tab="profile" type="button">Profile</button>
    <button class="tab" data-tab="jobs" type="button">Jobs</button>
    <button class="tab" data-tab="devices" type="button">Devices</button>
  </nav>

  <div id="panel-roles" class="panel active">
    <div class="split">
      <div>
        <section id="role-signals-section">
          <h2>What are you looking for?</h2>
          <p class="hint">Paste job links, or write loosely about what you want next. The more you add, the better the generated description.</p>
          <div id="role-signals-list"><p class="empty">Loading…</p></div>
          <form id="role-signal-form">
            <label for="role-signal-text">Add a note or link</label>
            <textarea id="role-signal-text" required placeholder="e.g. a link to a posting, or 'I want senior IC roles in applied AI, remote-friendly, not pure infra'"></textarea>
            <button type="submit">Add</button>
          </form>
          <p id="role-signal-status" class="status" role="status" aria-live="polite"></p>
        </section>
      </div>
      <div class="split-sticky">
        <section id="desired-roles-section">
          <h2>Generated description</h2>
          <label for="desired-roles-provider">Generate using</label>
          <select id="desired-roles-provider">
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
          <button id="desired-roles-generate-button" class="secondary" type="button">Generate description</button>
          <p id="desired-roles-generate-status" class="status" role="status" aria-live="polite"></p>
          <div id="desired-roles-draft-block" style="display:none">
            <label for="desired-roles-draft">Draft (review, then use or discard)</label>
            <textarea id="desired-roles-draft" readonly style="min-height:8rem"></textarea>
            <button id="desired-roles-use-draft" type="button">Use this draft</button>
          </div>
          <label for="desired-roles-description">Saved description</label>
          <textarea id="desired-roles-description" style="min-height:8rem" placeholder="What roles are you targeting?"></textarea>
          <button id="desired-roles-save-button" type="button">Save</button>
          <p id="desired-roles-save-status" class="status" role="status" aria-live="polite"></p>
        </section>
      </div>
    </div>
  </div>

  <div id="panel-profile" class="panel">
    <div class="split">
      <div>
        <section id="material-section">
          <h2>Your material</h2>
          <p class="hint">Upload files or add notes — this feeds the structured profile on the right.</p>
          <label for="profile-label">Name</label>
          <input id="profile-label" required placeholder="e.g. Jason Sheinkopf">
          <button id="save-name-button" class="secondary" type="button">Save name</button>
          <p id="profile-status" class="status" role="status" aria-live="polite"></p>

          <hr class="divider">

          <h3 class="subhead">Documents</h3>
          <div id="documents-list"><p class="empty">Loading…</p></div>
          <form id="document-form">
            <label for="document-file">Upload resume or notes file (PDF, plain text, or Markdown)</label>
            <input id="document-file" type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" required>
            <button type="submit">Upload</button>
          </form>
          <p id="document-status" class="status" role="status" aria-live="polite"></p>

          <hr class="divider">

          <h3 class="subhead">Notes about yourself</h3>
          <div id="notes-list"><p class="empty">Loading…</p></div>
          <form id="note-form">
            <label for="note-text">Add unstructured text (accomplishments, goals, background — anything)</label>
            <textarea id="note-text" required placeholder="Write freely; this feeds the profile generator"></textarea>
            <button type="submit">Add note</button>
          </form>
          <p id="note-status" class="status" role="status" aria-live="polite"></p>
        </section>
      </div>
      <div class="split-sticky">
        <section id="structured-profile-section">
          <h2>Your structured profile</h2>
          <label for="generate-provider">Generate from documents &amp; notes using</label>
          <select id="generate-provider">
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
          </select>
          <button id="generate-button" type="button">Generate structured profile</button>
          <p id="generate-status" class="status" role="status" aria-live="polite"></p>
          <div id="structured-draft-block" style="display:none">
            <h3 class="subhead">Draft — review, then save or discard</h3>
            <div id="structured-draft-view"></div>
            <button id="use-structured-draft" type="button">Save this</button>
            <button id="discard-structured-draft" class="secondary" type="button">Discard</button>
          </div>
          <div id="structured-profile-view"><p class="empty">No structured profile yet — add material on the left and generate.</p></div>
        </section>
      </div>
    </div>
  </div>

  <div id="panel-jobs" class="panel">
    <section id="jobs-section">
      <h2>Job postings</h2>
      <div id="jobs-list"><p class="empty">Loading…</p></div>
      <form id="job-form">
        <label for="job-title">Title</label>
        <input id="job-title" required placeholder="e.g. Senior Engineer">
        <label for="job-company">Company</label>
        <input id="job-company" required placeholder="e.g. Acme Corp">
        <label for="job-url">Posting URL (optional)</label>
        <input id="job-url" type="url" placeholder="https://...">
        <label for="job-description">Description</label>
        <textarea id="job-description" required placeholder="Paste the job description"></textarea>
        <button type="submit">Add job</button>
      </form>
      <p id="job-status" class="status" role="status" aria-live="polite"></p>
    </section>
  </div>

  <div id="panel-devices" class="panel">
    <section id="devices-section">
      <h2>Devices</h2>
      <div id="devices-list"><p class="empty">Loading…</p></div>
    </section>
  </div>
  </div>

  <script>
    document.querySelectorAll('nav .tab').forEach(function (tabButton) {
      tabButton.addEventListener('click', function () {
        document.querySelectorAll('nav .tab').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
        tabButton.classList.add('active');
        document.getElementById('panel-' + tabButton.dataset.tab).classList.add('active');
      });
    });

    function el(tag, props, children) {
      var node = document.createElement(tag);
      Object.keys(props || {}).forEach(function (key) { node[key] = props[key]; });
      (children || []).forEach(function (child) { node.appendChild(child); });
      return node;
    }
    function text(value) { return document.createTextNode(value); }

    function goToEnroll() { window.location.href = '/enroll'; }

    async function api(path, options) {
      var res = await fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}));
      if (res.status === 401) { goToEnroll(); throw new Error('not_authenticated'); }
      return res;
    }

    document.getElementById('sign-out').addEventListener('click', async function () {
      await api('/auth/logout', { method: 'POST' });
      goToEnroll();
    });

    async function loadProfile() {
      var res = await api('/profile');
      var data = await res.json();
      if (data.profile) {
        document.getElementById('profile-label').value = data.profile.label || '';
        document.getElementById('desired-roles-description').value = data.profile.desired_roles || '';
        renderStructuredProfileView('structured-profile-view', data.profile.structured);
      }
    }

    // Renders a list where each item shows one line, click to expand/collapse the full text.
    function renderCollapsibleList(listId, items, emptyText, getText, onDelete) {
      var list = document.getElementById(listId);
      list.innerHTML = '';
      if (!items.length) {
        list.appendChild(el('p', { className: 'empty', textContent: emptyText }));
        return;
      }
      items.forEach(function (item) {
        var full = getText(item);
        var oneLine = full.length > 72 ? full.slice(0, 72) + '…' : full;
        var expanded = false;
        var textEl = el('div', { className: 'collapsible-text', textContent: oneLine });
        textEl.addEventListener('click', function () {
          expanded = !expanded;
          textEl.textContent = expanded ? full : oneLine;
        });
        var del = el('button', { className: 'secondary', type: 'button', textContent: 'Remove' });
        del.addEventListener('click', async function (event) {
          event.stopPropagation();
          await onDelete(item);
        });
        var row = el('div', { className: 'row' }, [textEl, del]);
        list.appendChild(el('div', { className: 'row-item' }, [row]));
      });
    }

    function renderStructuredProfileView(containerId, structured) {
      var container = document.getElementById(containerId);
      container.innerHTML = '';
      var hasContent = structured && (
        structured.headline || structured.narrative_summary ||
        (structured.education && structured.education.length) ||
        (structured.experience && structured.experience.length) ||
        (structured.skills && structured.skills.length)
      );
      if (!hasContent) {
        container.appendChild(el('p', { className: 'empty', textContent: 'No structured profile yet — add material on the left and generate.' }));
        return;
      }
      if (structured.headline) container.appendChild(el('div', { className: 'row-title', textContent: structured.headline }));
      if (structured.narrative_summary) container.appendChild(el('p', { textContent: structured.narrative_summary }));
      if (structured.education && structured.education.length) {
        container.appendChild(el('h3', { className: 'subhead', textContent: 'Education' }));
        structured.education.forEach(function (item) {
          var line = [item.degree, item.field].filter(Boolean).join(' in ');
          var years = [item.start_year, item.end_year].filter(Boolean).join('–');
          container.appendChild(el('div', { className: 'row-item', textContent: [line, item.school, years].filter(Boolean).join(' · ') }));
        });
      }
      if (structured.experience && structured.experience.length) {
        container.appendChild(el('h3', { className: 'subhead', textContent: 'Experience' }));
        structured.experience.forEach(function (item) {
          var years = [item.start, item.end].filter(Boolean).join('–');
          var block = el('div', { className: 'row-item' }, [
            el('div', { className: 'row-title', textContent: [item.title, item.company].filter(Boolean).join(' — ') + (years ? ' (' + years + ')' : '') }),
          ]);
          (item.highlights || []).forEach(function (h) {
            block.appendChild(el('div', { className: 'row-meta', textContent: '• ' + h }));
          });
          container.appendChild(block);
        });
      }
      if (structured.skills && structured.skills.length) {
        container.appendChild(el('h3', { className: 'subhead', textContent: 'Skills' }));
        var pills = el('div', { className: 'skills-list' });
        structured.skills.forEach(function (skill) {
          pills.appendChild(el('span', { className: 'skill-pill', textContent: skill }));
        });
        container.appendChild(pills);
      }
    }

    async function loadRoleSignals() {
      var res = await api('/role-signals');
      var data = await res.json();
      renderCollapsibleList('role-signals-list', data.role_signals, 'Nothing added yet.', function (s) { return s.claim; }, async function (s) {
        await api('/role-signals/' + encodeURIComponent(s.id), { method: 'DELETE' });
        loadRoleSignals();
      });
    }

    document.getElementById('role-signal-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var statusEl = document.getElementById('role-signal-status');
      statusEl.textContent = 'Adding…';
      statusEl.className = 'status';
      try {
        var res = await api('/role-signals', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: document.getElementById('role-signal-text').value }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'add_failed');
        statusEl.textContent = 'Added.';
        statusEl.className = 'status success';
        document.getElementById('role-signal-form').reset();
        loadRoleSignals();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('desired-roles-generate-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('desired-roles-generate-status');
      var draftBlock = document.getElementById('desired-roles-draft-block');
      statusEl.textContent = 'Generating…';
      statusEl.className = 'status';
      draftBlock.style.display = 'none';
      try {
        var res = await api('/desired-roles/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: document.getElementById('desired-roles-provider').value }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'generation_failed');
        document.getElementById('desired-roles-draft').value = data.draft_description;
        draftBlock.style.display = 'block';
        statusEl.textContent = 'Draft ready below. Review before using it.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('desired-roles-use-draft').addEventListener('click', function () {
      document.getElementById('desired-roles-description').value = document.getElementById('desired-roles-draft').value;
      document.getElementById('desired-roles-draft-block').style.display = 'none';
      document.getElementById('desired-roles-generate-status').textContent = 'Draft copied below — click Save to keep it.';
    });

    document.getElementById('desired-roles-save-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('desired-roles-save-status');
      statusEl.textContent = 'Saving…';
      statusEl.className = 'status';
      try {
        var res = await api('/desired-roles', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ desired_roles: document.getElementById('desired-roles-description').value }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'save_failed');
        statusEl.textContent = 'Saved.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('save-name-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('profile-status');
      statusEl.textContent = 'Saving…';
      statusEl.className = 'status';
      try {
        var res = await api('/profile', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: document.getElementById('profile-label').value }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'save_failed');
        statusEl.textContent = 'Saved.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    var latestStructuredDraft = null;

    document.getElementById('generate-button').addEventListener('click', async function () {
      var statusEl = document.getElementById('generate-status');
      var draftBlock = document.getElementById('structured-draft-block');
      statusEl.textContent = 'Generating… this can take a little while.';
      statusEl.className = 'status';
      draftBlock.style.display = 'none';
      try {
        var res = await api('/profile/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: document.getElementById('generate-provider').value }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'generation_failed');
        latestStructuredDraft = data.draft_structured;
        renderStructuredProfileView('structured-draft-view', latestStructuredDraft);
        draftBlock.style.display = 'block';
        statusEl.textContent = 'Draft ready below. Review before saving it.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('use-structured-draft').addEventListener('click', async function () {
      var statusEl = document.getElementById('generate-status');
      if (!latestStructuredDraft) return;
      try {
        var res = await api('/profile/structured', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ structured: latestStructuredDraft }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'save_failed');
        document.getElementById('structured-draft-block').style.display = 'none';
        renderStructuredProfileView('structured-profile-view', latestStructuredDraft);
        statusEl.textContent = 'Saved.';
        statusEl.className = 'status success';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    document.getElementById('discard-structured-draft').addEventListener('click', function () {
      latestStructuredDraft = null;
      document.getElementById('structured-draft-block').style.display = 'none';
      document.getElementById('generate-status').textContent = 'Discarded.';
    });

    function renderDocuments(docs) {
      var list = document.getElementById('documents-list');
      list.innerHTML = '';
      if (!docs.length) {
        list.appendChild(el('p', { className: 'empty', textContent: 'No documents yet.' }));
        return;
      }
      docs.forEach(function (doc) {
        var rename = el('button', { className: 'secondary', type: 'button', textContent: 'Rename' });
        rename.addEventListener('click', async function () {
          var name = window.prompt('New name for this document:', doc.original_name);
          if (!name) return;
          await api('/documents/' + encodeURIComponent(doc.id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ original_name: name }),
          });
          loadDocuments();
        });
        var del = el('button', { className: 'secondary', type: 'button', textContent: 'Remove' });
        del.addEventListener('click', async function () {
          await api('/documents/' + encodeURIComponent(doc.id), { method: 'DELETE' });
          loadDocuments();
        });
        var meta = doc.media_type + (doc.has_text ? '' : ' — text not extracted, paste content as a note instead');
        var row = el('div', { className: 'row' }, [
          el('div', {}, [
            el('div', { className: 'row-title', textContent: doc.original_name }),
            el('div', { className: 'row-meta', textContent: meta }),
          ]),
          el('div', {}, [rename, del]),
        ]);
        list.appendChild(el('div', { className: 'row-item' }, [row]));
      });
    }

    async function loadDocuments() {
      var res = await api('/documents');
      var data = await res.json();
      renderDocuments(data.documents);
    }

    document.getElementById('document-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var statusEl = document.getElementById('document-status');
      var fileInput = document.getElementById('document-file');
      if (!fileInput.files.length) return;
      statusEl.textContent = 'Uploading…';
      statusEl.className = 'status';
      try {
        var formData = new FormData();
        formData.append('file', fileInput.files[0]);
        var res = await api('/documents', { method: 'POST', body: formData });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'upload_failed');
        statusEl.textContent = 'Uploaded.';
        statusEl.className = 'status success';
        document.getElementById('document-form').reset();
        loadDocuments();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    async function loadNotes() {
      var res = await api('/notes');
      var data = await res.json();
      renderCollapsibleList('notes-list', data.notes, 'No notes yet.', function (n) { return n.claim; }, async function (n) {
        await api('/notes/' + encodeURIComponent(n.id), { method: 'DELETE' });
        loadNotes();
      });
    }

    document.getElementById('note-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var statusEl = document.getElementById('note-status');
      statusEl.textContent = 'Adding…';
      statusEl.className = 'status';
      try {
        var res = await api('/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: document.getElementById('note-text').value }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'add_failed');
        statusEl.textContent = 'Added.';
        statusEl.className = 'status success';
        document.getElementById('note-form').reset();
        loadNotes();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    function renderJobs(jobs) {
      var list = document.getElementById('jobs-list');
      list.innerHTML = '';
      if (!jobs.length) {
        list.appendChild(el('p', { className: 'empty', textContent: 'No job postings yet.' }));
        return;
      }
      jobs.forEach(function (job) {
        var del = el('button', { className: 'secondary', type: 'button', textContent: 'Remove' });
        del.addEventListener('click', async function () {
          await api('/jobs/' + encodeURIComponent(job.id), { method: 'DELETE' });
          loadJobs();
        });
        var row = el('div', { className: 'row' }, [
          el('div', {}, [
            el('div', { className: 'row-title', textContent: job.title + ' — ' + job.company }),
            el('div', { className: 'row-meta', textContent: new Date(job.created_at).toLocaleDateString() }),
          ]),
          del,
        ]);
        list.appendChild(el('div', { className: 'row-item' }, [row]));
      });
    }

    async function loadJobs() {
      var res = await api('/jobs');
      var data = await res.json();
      renderJobs(data.jobs);
    }

    document.getElementById('job-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var statusEl = document.getElementById('job-status');
      statusEl.textContent = 'Adding…';
      statusEl.className = 'status';
      try {
        var res = await api('/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: document.getElementById('job-title').value,
            company: document.getElementById('job-company').value,
            source_url: document.getElementById('job-url').value,
            raw_description: document.getElementById('job-description').value,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'add_failed');
        statusEl.textContent = 'Added.';
        statusEl.className = 'status success';
        document.getElementById('job-form').reset();
        loadJobs();
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status error';
      }
    });

    function renderDevices(currentId, devices) {
      var list = document.getElementById('devices-list');
      list.innerHTML = '';
      devices.forEach(function (device) {
        var isCurrent = device.id === currentId;
        var children = [
          el('div', {}, [
            el('div', { textContent: device.device_name + (isCurrent ? ' (this device)' : '') }),
            el('div', { className: 'row-meta', textContent: 'Last seen ' + new Date(device.last_seen_at).toLocaleString() }),
          ]),
        ];
        if (!device.revoked) {
          var revoke = el('button', { className: 'secondary', type: 'button', textContent: 'Revoke' });
          revoke.addEventListener('click', async function () {
            await api('/devices/' + encodeURIComponent(device.id) + '/revoke', { method: 'POST' });
            if (isCurrent) { goToEnroll(); return; }
            loadDevices();
          });
          children.push(revoke);
        }
        list.appendChild(el('div', { className: 'row-item' }, [el('div', { className: 'row' }, children)]));
      });
    }

    async function loadDevices() {
      var res = await api('/devices');
      var data = await res.json();
      renderDevices(data.current_device_id, data.devices);
    }

    loadProfile();
    loadRoleSignals();
    loadDocuments();
    loadNotes();
    loadJobs();
    loadDevices();
  </script>
</body>
</html>`;

function dashboardPage(): Response {
  return new Response(DASHBOARD_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function downloadArtifact(request: Request, env: Env, key: string): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const object = await env.FILES.get(key);
  if (!object) return json({ error: "not_found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-store");
  return new Response(object.body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok", mode: "cloudflare" });
    if (request.method === "GET" && url.pathname === "/enroll") return enrollPage();
    if (request.method === "GET" && url.pathname === "/") {
      const auth = await requireSession(request, env);
      if (auth instanceof Response) return Response.redirect(new URL("/enroll", request.url).toString(), 302);
      return dashboardPage();
    }
    if (request.method === "GET" && url.pathname === "/profile") return getProfile(request, env);
    if (request.method === "PUT" && url.pathname === "/profile") return upsertProfile(request, env);
    if (request.method === "PUT" && url.pathname === "/profile/structured") return saveStructuredProfile(request, env);
    if (request.method === "GET" && url.pathname === "/jobs") return listJobs(request, env);
    if (request.method === "POST" && url.pathname === "/jobs") return createJob(request, env);
    const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (request.method === "DELETE" && jobMatch) return deleteJob(request, env, jobMatch[1]);
    if (request.method === "GET" && url.pathname === "/documents") return listDocuments(request, env);
    if (request.method === "POST" && url.pathname === "/documents") return uploadDocument(request, env);
    const documentMatch = url.pathname.match(/^\/documents\/([^/]+)$/);
    if (request.method === "PATCH" && documentMatch) return renameDocument(request, env, documentMatch[1]);
    if (request.method === "DELETE" && documentMatch) return deleteDocument(request, env, documentMatch[1]);
    if (request.method === "GET" && url.pathname === "/notes") return listNotes(request, env);
    if (request.method === "POST" && url.pathname === "/notes") return createNote(request, env);
    const noteMatch = url.pathname.match(/^\/notes\/([^/]+)$/);
    if (request.method === "DELETE" && noteMatch) return deleteNote(request, env, noteMatch[1]);
    if (request.method === "POST" && url.pathname === "/profile/generate") return generateProfile(request, env);
    if (request.method === "GET" && url.pathname === "/role-signals") return listRoleSignals(request, env);
    if (request.method === "POST" && url.pathname === "/role-signals") return createRoleSignal(request, env);
    const roleSignalMatch = url.pathname.match(/^\/role-signals\/([^/]+)$/);
    if (request.method === "DELETE" && roleSignalMatch) return deleteRoleSignal(request, env, roleSignalMatch[1]);
    if (request.method === "PUT" && url.pathname === "/desired-roles") return saveDesiredRoles(request, env);
    if (request.method === "POST" && url.pathname === "/desired-roles/generate") return generateDesiredRoles(request, env);
    if (request.method === "POST" && url.pathname === "/admin/enrollments") return createEnrollment(request, env);
    if (request.method === "POST" && url.pathname === "/auth/enroll") return exchangeEnrollment(request, env);
    if (request.method === "POST" && url.pathname === "/auth/logout") {
      return json({ authenticated: false }, 200, { "set-cookie": clearSessionCookie() });
    }
    if (request.method === "GET" && url.pathname === "/devices") return listDevices(request, env);
    const deviceMatch = url.pathname.match(/^\/devices\/([^/]+)\/revoke$/);
    if (request.method === "POST" && deviceMatch) return revokeDevice(request, env, deviceMatch[1]);
    if (request.method === "POST" && url.pathname === "/artifacts") return uploadArtifact(request, env);
    const artifactMatch = url.pathname.match(/^\/artifacts\/(.+)$/);
    if (request.method === "GET" && artifactMatch) return downloadArtifact(request, env, decodeURIComponent(artifactMatch[1]));
    if (request.method === "GET" && url.pathname === "/me") {
      const auth = await requireSession(request, env);
      return auth instanceof Response ? auth : json({ authenticated: true, device: auth });
    }
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
