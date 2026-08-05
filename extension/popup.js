// The popup is the whole UI: connect once, then fill, answer whatever was left blank, and record
// that you applied. It talks to the Worker with a bearer token, since a cookie set on the ApplyGo
// origin is not available from an ATS page.

const $ = (id) => document.getElementById(id);

let state = { apiBase: '', token: '', lastMissing: [], lastJobId: null };

async function loadState() {
  const stored = await chrome.storage.local.get(['apiBase', 'token']);
  state.apiBase = stored.apiBase || '';
  state.token = stored.token || '';
  $('setup').style.display = state.token ? 'none' : 'block';
  $('main').style.display = state.token ? 'block' : 'none';
}

async function api(path, options = {}) {
  return fetch(state.apiBase + path, {
    ...options,
    headers: {
      authorization: 'Bearer ' + state.token,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
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
    setStatus(status, 'Error: ' + err.message, 'error');
  }
});

$('signout').addEventListener('click', async () => {
  await chrome.storage.local.remove(['apiBase', 'token']);
  await loadState();
});

/**
 * Finds the ApplyGo job whose posting URL matches the tab we're on, so answers can draw on that
 * job's tailored resume and cover letter. Matching on URL rather than asking the user to pick keeps
 * the flow to a single click; when nothing matches, filling still works from the profile alone.
 */
async function findJobForUrl(url) {
  try {
    const res = await api('/jobs');
    if (!res.ok) return null;
    const data = await res.json();
    const jobs = data.jobs || [];
    const normalize = (u) => String(u || '').split('?')[0].replace(/\/+$/, '');
    const here = normalize(url);
    const exact = jobs.find((j) => normalize(j.source_url) === here);
    if (exact) return exact;
    // Application pages often hang off the posting URL (".../jobs/123#app"), so a prefix counts.
    return jobs.find((j) => j.source_url && here.startsWith(normalize(j.source_url))) || null;
  } catch {
    return null;
  }
}

$('fill').addEventListener('click', async () => {
  const status = $('status');
  const button = $('fill');
  button.disabled = true;
  $('missing').style.display = 'none';
  $('applied-block').style.display = 'none';
  setStatus(status, 'Reading the form…');

  try {
    const tab = await activeTab();
    const read = await chrome.tabs.sendMessage(tab.id, { type: 'READ_FORM' });
    if (!read || !read.fields.length) throw new Error('no form fields found on this page');

    setStatus(status, 'Matching ' + read.fields.length + ' fields…');
    const job = await findJobForUrl(read.url);
    state.lastJobId = job ? job.id : null;

    const res = await api('/applications/match', {
      method: 'POST',
      body: JSON.stringify({ job_id: state.lastJobId, fields: read.fields }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'match failed (HTTP ' + res.status + ')');

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'FILL',
      answers: data.answers || [],
      missing: data.missing || [],
      resumeUrl: data.resume_url,
      coverLetterText: data.cover_letter_text,
      apiBase: state.apiBase,
      token: state.token,
    });

    state.lastMissing = data.missing || [];
    renderMissing();

    const bits = [`Filled ${result.filled} field${result.filled === 1 ? '' : 's'}`];
    if (result.resumeAttached) bits.push('attached your resume');
    if (!job) bits.push('no matching ApplyGo job, used your profile only');
    setStatus(status, bits.join(', ') + '.', 'ok');
    if (state.lastJobId) $('applied-block').style.display = 'block';
  } catch (err) {
    const hint = /Receiving end does not exist/i.test(err.message)
      ? 'this page is not a supported job board, or needs a reload'
      : err.message;
    setStatus(status, 'Error: ' + hint, 'error');
  } finally {
    button.disabled = false;
  }
});

/**
 * Anything the Worker declined to answer is asked here instead. Saving one writes it to the answer
 * bank, so the same question on the next company's form is already handled.
 */
function renderMissing() {
  const host = $('missing-list');
  host.innerHTML = '';
  if (!state.lastMissing.length) {
    $('missing').style.display = 'none';
    return;
  }
  $('missing').style.display = 'block';

  state.lastMissing.forEach((field) => {
    const wrap = document.createElement('div');
    wrap.className = 'q';

    const question = document.createElement('p');
    question.textContent = field.label;
    wrap.appendChild(question);

    const row = document.createElement('div');
    row.className = 'row';

    const input = document.createElement('input');
    input.placeholder = field.options && field.options.length ? field.options.join(' / ') : 'Your answer';
    row.appendChild(input);

    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    save.addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value) return;
      save.disabled = true;
      try {
        await api('/application-answers', {
          method: 'PUT',
          body: JSON.stringify({ question: field.label, answer: value }),
        });
        const tab = await activeTab();
        await chrome.tabs.sendMessage(tab.id, { type: 'FILL', answers: [{ name: field.name, value }] });
        state.lastMissing = state.lastMissing.filter((f) => f.name !== field.name);
        renderMissing();
        setStatus($('status'), 'Saved. It will be filled automatically next time.', 'ok');
      } catch (err) {
        setStatus($('status'), 'Error: ' + err.message, 'error');
        save.disabled = false;
      }
    });
    row.appendChild(save);

    wrap.appendChild(row);
    host.appendChild(wrap);
  });
}

$('mark-applied').addEventListener('click', async () => {
  if (!state.lastJobId) return;
  const button = $('mark-applied');
  button.disabled = true;
  try {
    const res = await api('/jobs/' + encodeURIComponent(state.lastJobId) + '/fit', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'applied' }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    setStatus($('status'), 'Recorded. Moved to the Applied tab.', 'ok');
  } catch (err) {
    setStatus($('status'), 'Error: ' + err.message, 'error');
    button.disabled = false;
  }
});

loadState();
