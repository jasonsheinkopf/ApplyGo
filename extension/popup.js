// Connection management only.
//
// Filling an application used to happen here, which meant the assistant vanished the moment you
// clicked back into the form you were filling. That work now lives in the injected sidebar
// (sidebar.js), and the popup is left doing the one thing a popup is genuinely good for: a
// setup step you perform once.

const $ = (id) => document.getElementById(id);

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

async function loadState() {
  const stored = await chrome.storage.local.get(['apiBase', 'token']);
  const connected = Boolean(stored.apiBase && stored.token);
  $('setup').style.display = connected ? 'none' : 'block';
  $('main').style.display = connected ? 'block' : 'none';
  if (connected) $('connected-to').textContent = 'Connected to ' + stored.apiBase.replace(/^https?:\/\//, '');
  // Pre-filling the local dev URL costs nothing and removes the single most common setup mistake:
  // pasting a code created against one database into an installation pointed at a different one.
  if (!connected && !$('api').value) $('api').value = 'http://localhost:8787';
}

$('connect').addEventListener('click', async () => {
  const status = $('setup-status');
  const code = $('code').value.trim();
  const apiBase = $('api').value.trim().replace(/\/$/, '');
  if (!code || !apiBase) return setStatus(status, 'Both fields are required.', 'error');

  setStatus(status, 'Connecting…');
  try {
    const res = await fetch(apiBase + '/auth/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, device_name: 'Browser extension', return_token: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) throw new Error(data.error || 'enrollment failed (HTTP ' + res.status + ')');
    await chrome.storage.local.set({ apiBase, token: data.token });
    await loadState();
    setStatus(status, 'Connected.', 'ok');
  } catch (err) {
    const hint = /Failed to fetch/i.test(err.message)
      ? "couldn't reach that ApplyGo URL — is it running?"
      : err.message;
    setStatus(status, 'Error: ' + hint, 'error');
  }
});

$('signout').addEventListener('click', async () => {
  await chrome.storage.local.remove(['apiBase', 'token']);
  await loadState();
});

$('open').addEventListener('click', async () => {
  const status = $('status');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_SIDEBAR' });
    if (res?.ok) window.close();
    else setStatus(status, "This page doesn't look like an application form.", 'error');
  } catch {
    setStatus(status, 'ApplyGo does not run on this site. Open an application on a supported job board.', 'error');
  }
});

loadState();
