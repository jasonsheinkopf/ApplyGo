// The extension's one network path.
//
// Content scripts cannot call the Worker directly: an MV3 content-script fetch is attributed to the
// page's own origin (boards.greenhouse.io and friends), and the Worker deliberately only sends CORS
// headers to `chrome-extension://` origins -- see EXTENSION_CORS_PATHS in cloudflare/src/index.ts,
// which is a security boundary worth keeping rather than widening. A service worker fetch runs in
// the extension's own context under host_permissions, so it isn't subject to page CORS at all.
//
// That makes this the single place holding the bearer token, which is also where it should be: the
// injected sidebar runs on an employer's page, and never having the token in that world means a
// hostile page can't read it out of a variable.

const API_TIMEOUT_MS = 30000;

async function credentials() {
  const stored = await chrome.storage.local.get(['apiBase', 'token']);
  return { apiBase: stored.apiBase || '', token: stored.token || '' };
}

/** Fetches an ApplyGo API path and returns a plain, structured-clone-safe result. */
async function apiFetch({ path, method = 'GET', body }) {
  const { apiBase, token } = await credentials();
  if (!apiBase || !token) return { ok: false, status: 0, error: 'not_connected' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(apiBase + path, {
      method,
      signal: controller.signal,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : (data?.error || 'http_' + res.status) };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Binary has to cross the messaging boundary as a string, so the resume PDF comes back base64 and
 * the content script rebuilds the File. Chunked conversion because a spread over a whole PDF's
 * bytes overflows the call stack on anything non-trivial.
 */
async function fetchResumeBase64(path) {
  const { apiBase, token } = await credentials();
  if (!apiBase || !token) return { ok: false, error: 'not_connected' };
  try {
    const res = await fetch(apiBase + path, { headers: { authorization: 'Bearer ' + token } });
    if (!res.ok) return { ok: false, error: 'http_' + res.status };
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return { ok: true, base64: btoa(binary) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'API') {
    apiFetch(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === 'API_RESUME') {
    fetchResumeBase64(msg.path).then(sendResponse);
    return true;
  }
  if (msg?.type === 'API_STATUS') {
    credentials().then(({ apiBase, token }) => sendResponse({ connected: Boolean(apiBase && token), apiBase }));
    return true;
  }
  return false;
});
