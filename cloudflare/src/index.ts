interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  SETUP_SECRET: string;
  SESSION_DAYS: string;
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

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  created_at: string;
  updated_at: string;
};

async function getProfile(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const profile = await env.DB.prepare(
    "SELECT id, label, summary, preferences_json, created_at, updated_at FROM candidate_profiles ORDER BY created_at ASC LIMIT 1",
  ).first<Profile>();
  return json({ profile: profile ?? null });
}

async function upsertProfile(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => ({}))) as { label?: string; summary?: string };
  const label = (body.label ?? "").trim();
  const summary = (body.summary ?? "").trim();
  if (!label) return json({ error: "label_required" }, 400);
  const existing = await env.DB.prepare(
    "SELECT id FROM candidate_profiles ORDER BY created_at ASC LIMIT 1",
  ).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare(
      "UPDATE candidate_profiles SET label = ?, summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
      .bind(label, summary, existing.id)
      .run();
    return json({ id: existing.id, label, summary });
  }
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO candidate_profiles (id, label, summary) VALUES (?, ?, ?)")
    .bind(id, label, summary)
    .run();
  return json({ id, label, summary }, 201);
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
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 0 auto 4rem; padding: 0 1.25rem; line-height: 1.5; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 1.25rem 0; }
  h1 { font-size: 1.25rem; margin: 0; }
  h2 { font-size: 1rem; margin: 0 0 0.75rem; }
  section { margin: 1.75rem 0; padding: 1rem; border: 1px solid light-dark(#ddd, #333); border-radius: 0.6rem; }
  label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 600; font-size: 0.9rem; }
  input, textarea { width: 100%; padding: 0.55rem; font-size: 1rem; box-sizing: border-box; font-family: inherit; }
  textarea { min-height: 5rem; resize: vertical; }
  button { margin-top: 1rem; padding: 0.6rem 1.1rem; font-size: 0.95rem; cursor: pointer; }
  button.secondary { background: none; border: 1px solid light-dark(#999, #666); }
  #sign-out { margin-top: 0; padding: 0.4rem 0.8rem; font-size: 0.85rem; }
  .status { margin-top: 0.6rem; font-weight: 600; font-size: 0.9rem; min-height: 1.1rem; }
  .status.success { color: #16794e; }
  .status.error { color: #b3261e; }
  .job, .device { padding: 0.75rem 0; border-top: 1px solid light-dark(#eee, #2a2a2a); }
  .job:first-child, .device:first-child { border-top: none; padding-top: 0; }
  .job-title { font-weight: 600; }
  .job-meta { font-size: 0.85rem; opacity: 0.75; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .empty { opacity: 0.6; font-size: 0.9rem; }
</style>
</head>
<body>
  <header>
    <h1>ApplyGo</h1>
    <button id="sign-out" class="secondary" type="button">Sign out</button>
  </header>

  <section id="profile-section">
    <h2>Profile</h2>
    <form id="profile-form">
      <label for="profile-label">Name / label</label>
      <input id="profile-label" required placeholder="e.g. Jason Sheinkopf">
      <label for="profile-summary">Summary</label>
      <textarea id="profile-summary" placeholder="Short professional summary"></textarea>
      <button type="submit">Save profile</button>
    </form>
    <p id="profile-status" class="status" role="status" aria-live="polite"></p>
  </section>

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

  <section id="devices-section">
    <h2>Devices</h2>
    <div id="devices-list"><p class="empty">Loading…</p></div>
  </section>

  <script>
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
        document.getElementById('profile-label').value = data.profile.label;
        document.getElementById('profile-summary').value = data.profile.summary;
      }
    }

    document.getElementById('profile-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var statusEl = document.getElementById('profile-status');
      statusEl.textContent = 'Saving…';
      statusEl.className = 'status';
      try {
        var res = await api('/profile', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            label: document.getElementById('profile-label').value,
            summary: document.getElementById('profile-summary').value,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'save_failed');
        statusEl.textContent = 'Saved.';
        statusEl.className = 'status success';
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
            el('div', { className: 'job-title', textContent: job.title + ' — ' + job.company }),
            el('div', { className: 'job-meta', textContent: new Date(job.created_at).toLocaleDateString() }),
          ]),
          del,
        ]);
        list.appendChild(el('div', { className: 'job' }, [row]));
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
            el('div', { className: 'job-meta', textContent: 'Last seen ' + new Date(device.last_seen_at).toLocaleString() }),
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
        list.appendChild(el('div', { className: 'device' }, [el('div', { className: 'row' }, children)]));
      });
    }

    async function loadDevices() {
      var res = await api('/devices');
      var data = await res.json();
      renderDevices(data.current_device_id, data.devices);
    }

    loadProfile();
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
    if (request.method === "GET" && url.pathname === "/jobs") return listJobs(request, env);
    if (request.method === "POST" && url.pathname === "/jobs") return createJob(request, env);
    const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (request.method === "DELETE" && jobMatch) return deleteJob(request, env, jobMatch[1]);
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
