// The in-page ApplyGo assistant.
//
// Injected into the employer's application page rather than living in the Chrome popup, because the
// assistant has to stay with the candidate while they scroll, read, and answer -- a popup that
// closes the moment you click the page is the wrong shape for something that follows an application
// from start to finish.
//
// Everything renders inside a shadow root. The employer's stylesheet cannot reach in and this
// cannot leak out, which matters when the host page is an arbitrary ATS with its own opinions about
// `button {}`. The whole UI lives under #applygo-agent-root, the one id content.js skips when
// reading the form, so the assistant can never mistake its own controls for the employer's.

const ROOT_ID = 'applygo-agent-root';
const MIN_FIELDS_TO_OFFER = 3;

// Two identities, deliberately not interchangeable: the ApplyGo logo is the product, shown once in
// the header; Mon-chan's avatar is the agent, shown wherever Mon-chan is the one communicating
// (status lines, questions, flags) so the candidate learns to read "Mon-chan is here" as "this is
// the AI agent talking to me." Real artwork (media/images/), not generated/vector art.
const MON_CHAN_URL = chrome.runtime.getURL('images/mon-chan-avatar.png');
const APPLYGO_LOGO_URL = chrome.runtime.getURL('images/applygo-logo.png');

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .tab {
    position: fixed; right: 0; top: 50%; transform: translateY(-50%);
    width: 46px; height: 62px; border: 0; border-radius: 12px 0 0 12px;
    background: #4f46e5; cursor: pointer; z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 3px 14px rgba(0,0,0,0.24); padding: 0;
    transition: width 0.12s ease;
  }
  .tab:hover { width: 52px; }
  .tab .badge {
    position: absolute; top: -5px; left: -5px; min-width: 18px; height: 18px; border-radius: 9px;
    background: #d97706; color: #fff; font-size: 11px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; padding: 0 4px;
  }
  .panel {
    position: fixed; right: 0; top: 0; height: 100vh; width: 372px; max-width: 100vw;
    background: #ffffff; color: #18181b; z-index: 2147483647;
    box-shadow: -4px 0 22px rgba(0,0,0,0.16);
    display: flex; flex-direction: column; border-left: 1px solid #e4e4e7;
  }
  header {
    display: flex; align-items: center; gap: 10px; padding: 12px 14px;
    border-bottom: 1px solid #e4e4e7; background: #fafafa;
  }
  header .who { flex: 1; min-width: 0; }
  header .name { font-size: 14px; font-weight: 700; }
  header .name em { font-style: normal; color: #4f46e5; }
  header .sub { font-size: 11px; color: #71717a; }
  .applygo-logo { flex: none; border-radius: 9px; object-fit: cover; display: block; }
  .mon-chan { flex: none; border-radius: 999px; object-fit: cover; display: block; }
  .collapse {
    border: 1px solid #d4d4d8; background: #fff; border-radius: 8px; cursor: pointer;
    width: 30px; height: 30px; font-size: 15px; line-height: 1; color: #3f3f46;
  }
  .collapse:hover { background: #f4f4f5; }
  .body { flex: 1; overflow-y: auto; padding: 14px; }
  .job { border: 1px solid #e4e4e7; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
  .job .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #71717a; }
  .job .title { font-size: 14px; font-weight: 650; margin-top: 2px; }
  .job .company { font-size: 12px; color: #52525b; }
  .resume {
    border: 1px solid #e4e4e7; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px;
    display: flex; align-items: center; gap: 9px;
  }
  .resume .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #71717a; }
  .resume .info { flex: 1; min-width: 0; }
  .resume .fname { font-size: 12.5px; font-weight: 600; margin-top: 1px; }
  .resume .state { font-size: 11px; margin-top: 1px; }
  .resume .state.pending { color: #b45309; }
  .resume .state.verified { color: #15803d; }
  .resume .state.failed { color: #b91c1c; }
  .say {
    display: flex; gap: 9px; align-items: flex-start;
    background: #eef2ff; border: 1px solid #e0e7ff; border-radius: 10px;
    padding: 10px 12px; font-size: 13px; line-height: 1.45; margin-bottom: 12px;
  }
  .say .pip { flex: none; margin-top: -2px; }
  button.primary {
    width: 100%; padding: 11px; font-size: 14px; font-weight: 650; cursor: pointer;
    background: #4f46e5; color: #fff; border: 1px solid #4f46e5; border-radius: 9px;
  }
  button.primary:disabled { opacity: 0.5; cursor: default; }
  button.ghost {
    padding: 8px 11px; font-size: 13px; font-weight: 600; cursor: pointer;
    background: #fff; color: #18181b; border: 1px solid #d4d4d8; border-radius: 8px;
  }
  button.ghost:hover { background: #f4f4f5; }
  .ask { border: 1px solid #c7d2fe; border-radius: 10px; padding: 12px; margin-bottom: 12px; background: #fff; }
  .ask .asker { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 4px; }
  .ask .asker .mon-chan { margin-top: 1px; }
  .ask .q { font-size: 13.5px; font-weight: 650; margin: 0; line-height: 1.4; }
  .ask .why { font-size: 12px; color: #52525b; margin: 0 0 10px; line-height: 1.45; }
  .ask .opts { display: flex; flex-wrap: wrap; gap: 6px; }
  .ask input, .ask textarea, .ask select {
    width: 100%; padding: 8px 9px; font-size: 13px; border: 1px solid #d4d4d8; border-radius: 8px;
    margin-bottom: 8px; font-family: inherit;
  }
  .ask textarea { min-height: 92px; resize: vertical; }
  .sensitive { font-size: 11px; color: #92400e; background: #fffbeb; border: 1px solid #fde68a;
    border-radius: 7px; padding: 6px 8px; margin-bottom: 9px; }
  .draftnote { font-size: 11px; color: #92400e; margin: -3px 0 8px; line-height: 1.4; }
  .remember { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #52525b; margin: 0 0 9px; }
  .remember input { width: auto; margin: 0; }
  .leaveblank {
    display: block; background: none; border: 0; color: #71717a; font-size: 11.5px; cursor: pointer;
    padding: 8px 0 0; text-decoration: underline;
  }
  .progress { margin-top: 14px; }
  .progress h3 {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #71717a;
    margin: 0 0 7px; font-weight: 700;
  }
  .bar { height: 5px; border-radius: 3px; background: #e4e4e7; overflow: hidden; margin-bottom: 10px; }
  .bar > i { display: block; height: 100%; background: #4f46e5; transition: width 0.2s ease; }
  ul.fields { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  ul.fields li { display: flex; gap: 7px; font-size: 12.5px; align-items: baseline; line-height: 1.4; }
  ul.fields .ic { flex: none; width: 13px; font-weight: 700; }
  .ok .ic { color: #15803d; } .warn .ic { color: #b45309; } .bad .ic { color: #b91c1c; }
  .todo .ic { color: #a1a1aa; } .todo { color: #71717a; }
  .fname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group { margin-top: 12px; }
  .relabel {
    background: none; border: 0; color: #4f46e5; font-size: 11.5px; cursor: pointer;
    padding: 0; text-decoration: underline; flex: none;
  }
  footer { padding: 11px 14px; border-top: 1px solid #e4e4e7; background: #fafafa; }
  footer p { margin: 0 0 8px; font-size: 11.5px; color: #71717a; line-height: 1.45; }
  .setup { font-size: 13px; line-height: 1.5; }
  .setup code { background: #f4f4f5; padding: 1px 4px; border-radius: 4px; font-size: 12px; }
`;

class ApplyGoSidebar {
  constructor(agent) {
    this.agent = agent;
    this.open_ = false;
    this.host = null;
    this.root = null;
    agent.onUpdate(() => this.render());
  }

  /** First-time creation only. Everything after that goes through ensureMounted(). */
  mount() {
    if (this.host) return this.ensureMounted();
    this.createHost();
    this.render();
  }

  createHost() {
    this.host = document.createElement('div');
    this.host.id = ROOT_ID;
    // A page that styles `div {}` aggressively can still reach the host element itself, so the
    // handful of properties that decide whether this is visible at all are pinned here.
    this.host.setAttribute('style', 'all: initial; position: static;');
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    shadow.appendChild(style);
    this.root = document.createElement('div');
    shadow.appendChild(this.root);
    document.documentElement.appendChild(this.host);
  }

  /**
   * Puts the sidebar back in the document if something removed it. Greenhouse/Lever/Ashby all
   * rerender large chunks of the DOM as their own SPA navigates between steps, which routinely
   * takes #applygo-agent-root out with it even though nothing about the extension changed.
   *
   * Reuses the existing host/shadow root and never touches the agent, so open/collapsed state,
   * the in-progress application state, and any pending question all survive a reattach -- none of
   * that lives on the DOM node that got removed, only on `this` and on `this.agent`.
   */
  ensureMounted() {
    if (!this.host) {
      this.createHost();
      this.render();
      return;
    }
    if (!this.host.isConnected) {
      document.documentElement.appendChild(this.host);
      this.render();
    }
  }

  open() {
    this.ensureMounted();
    this.open_ = true;
    this.render();
  }

  /** Opened from the toolbar icon rather than the edge tab, so it may need to introduce itself. */
  async openManually() {
    this.open();
    if (!this.prepared) {
      this.prepared = true;
      await this.agent.prepare();
    }
  }

  collapse() {
    this.open_ = false;
    this.render();
  }

  /** Mon-chan: the agent. Shown wherever Mon-chan is the one communicating -- not the product chrome. */
  monChan(size = 32) {
    return `<img class="mon-chan" src="${MON_CHAN_URL}" width="${size}" height="${size}" alt="Mon-chan">`;
  }

  /** The ApplyGo logo: the product. Shown once, in the header. */
  applygoLogo(size = 40) {
    return `<img class="applygo-logo" src="${APPLYGO_LOGO_URL}" width="${size}" height="${size}" alt="ApplyGo">`;
  }

  render() {
    if (!this.root) return;
    const s = this.agent.state;
    this.root.innerHTML = this.open_ ? this.panelHtml(s) : this.tabHtml(s);
    this.wire(s);
  }

  tabHtml(s) {
    const waiting = s.status === 'waiting_user';
    return `
      <button class="tab" part="tab" title="Open the ApplyGo Application Assistant" aria-label="Open ApplyGo">
        ${waiting ? '<span class="badge">1</span>' : ''}
        ${this.monChan(30)}
      </button>`;
  }

  panelHtml(s) {
    return `
      <aside class="panel" role="complementary" aria-label="ApplyGo Application Assistant">
        <header>
          ${this.applygoLogo(40)}
          <div class="who">
            <div class="name">Apply<em>Go</em></div>
            <div class="sub">Application Assistant</div>
          </div>
          <button class="collapse" title="Collapse" aria-label="Collapse ApplyGo">&rsaquo;</button>
        </header>
        <div class="body">${this.bodyHtml(s)}</div>
        <footer>
          <p>ApplyGo never submits an application. You review it and press submit yourself.</p>
          ${s.jobId ? '<button class="ghost" data-act="applied">I submitted this — mark it applied</button>' : ''}
        </footer>
      </aside>`;
  }

  bodyHtml(s) {
    if (!s.connected) {
      return `
        <div class="say"><span class="pip">${this.monChan(26)}</span>
          <span>I'm not connected to your ApplyGo yet.</span></div>
        <p class="setup">Open the ApplyGo extension icon in your toolbar, paste an enrollment code from
        <code>Settings &rsaquo; Devices</code>, and I'll be ready on the next page load.</p>`;
    }

    const parts = [];
    if (s.job) {
      parts.push(`
        <div class="job">
          <div class="lbl">Applying to</div>
          <div class="title">${escapeHtml(s.job.title)}</div>
          <div class="company">${escapeHtml(s.job.company || '')}</div>
        </div>`);
    }

    if (s.assets.resumeUrl) parts.push(this.resumeHtml(s));

    parts.push(`
      <div class="say"><span class="pip">${this.monChan(26)}</span>
        <span>${escapeHtml(s.statusText || 'Ready when you are.')}</span></div>`);

    if (s.pendingQuestion) parts.push(this.questionHtml(s.pendingQuestion));

    const busy = s.status === 'planning' || s.status === 'working' || s.status === 'reviewing';
    if (!s.pendingQuestion) {
      const label = s.status === 'complete' ? 'Run autofill again' : 'Autofill application';
      parts.push(`<button class="primary" data-act="run" ${busy ? 'disabled' : ''}>${busy ? 'Working…' : label}</button>`);
    }

    if (!s.assets.resume && s.jobId && s.status !== 'idle') {
      parts.push(`
        <div class="group say"><span class="pip">${this.monChan(22)}</span>
          <span>I don't have a tailored resume for this job yet — you can generate one in ApplyGo.</span></div>`);
    }

    if (s.fields.length) parts.push(this.progressHtml(s));
    if (s.finalReport) parts.push(this.reportHtml(s.finalReport));
    return parts.join('');
  }

  /** Which resume ApplyGo is using for this application, so the candidate can verify it before it's
   * ever uploaded -- see spec: "the user should be able to understand WHICH resume is being used." */
  resumeHtml(s) {
    const verified = Boolean(s.assets.resumeVerified);
    const settled = s.status === 'complete' || s.status === 'reviewing' || s.status === 'error';
    const stateClass = verified ? 'verified' : settled ? 'failed' : 'pending';
    const stateText = verified ? 'Verified attached' : settled ? "Didn't verify as attached" : 'Attaching…';
    const previewHref = s.apiBase ? `${s.apiBase}${s.assets.resumeUrl}` : '';
    return `
      <div class="resume">
        <div class="info">
          <div class="lbl">Resume</div>
          <div class="fname">${escapeHtml(s.assets.resumeFilename || 'Resume.pdf')}</div>
          <div class="state ${stateClass}">${stateText}</div>
        </div>
        ${previewHref ? `<a class="relabel" href="${escapeAttr(previewHref)}" target="_blank" rel="noopener">Preview</a>` : ''}
      </div>`;
  }

  /**
   * The question UI adapts to the control the employer actually used. There is no Skip: a field
   * stays outstanding until it's filled, saved, or -- only when the employer's own form marks it
   * optional -- explicitly left blank.
   */
  questionHtml(q) {
    if (q.kind === 'conflict') {
      return `
        <div class="ask">
          <div class="asker">${this.monChan(22)}<p class="q">${escapeHtml(q.prompt)}</p></div>
          <p class="why">Your new answer is what I'll put on this application either way.</p>
          <div class="opts">
            <button class="ghost" data-conflict="update">Update the saved answer</button>
            <button class="ghost" data-conflict="keep">Just this once</button>
          </div>
        </div>`;
    }

    const field = q.field;
    const options = field.options || [];
    const sensitiveNote = field.sensitive
      ? '<p class="sensitive">ApplyGo never guesses this kind of question — only you can answer it.</p>'
      : '';
    const leaveBlank = field.required
      ? ''
      : '<button class="leaveblank" data-leave-blank>Leave blank (optional)</button>';

    // A genuine checkbox is a real binary control -- Yes/No is a legitimate mapping for it. A radio
    // or select only ever shows the employer's actual options; with none available (yet, or ever),
    // this falls back to a manual answer rather than inventing choices that were never on the form.
    const isChoice = field.type === 'checkbox' || ((field.type === 'radio' || field.type === 'select') && options.length > 0);

    if (isChoice) {
      const choices = field.type === 'checkbox' ? ['Yes', 'No'] : options;
      return `
        <div class="ask">
          <div class="asker">${this.monChan(22)}<p class="q">${escapeHtml(field.label)}</p></div>
          <p class="why">${escapeHtml(q.prompt)}</p>
          ${sensitiveNote}
          <label class="remember"><input type="checkbox" data-also-save> Also save this for future applications</label>
          <div class="opts">${choices
            .map((o) => `<button class="ghost" data-choice="${escapeAttr(o)}">${escapeHtml(o)}</button>`)
            .join('')}</div>
          ${leaveBlank}
        </div>`;
    }

    const maxLenAttr = field.maxLength ? ` maxlength="${Number(field.maxLength)}"` : '';
    const control = field.type === 'textarea'
      ? `<textarea data-input placeholder="Your answer"${maxLenAttr}></textarea>`
      : `<input data-input type="${field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}" placeholder="Your answer"${maxLenAttr}>`;

    return `
      <div class="ask">
        <div class="asker">${this.monChan(22)}<p class="q">${escapeHtml(field.label)}</p></div>
        <p class="why">${escapeHtml(q.prompt)}</p>
        ${sensitiveNote}
        ${control}
        <p class="draftnote" data-draftnote></p>
        ${field.canGenerate ? '<div class="opts"><button class="ghost" data-generate>Generate</button></div>' : ''}
        <div class="opts">
          <button class="ghost" data-submit-fill>Fill</button>
          <button class="ghost" data-submit-save>Save</button>
        </div>
        ${leaveBlank}
      </div>`;
  }

  progressHtml(s) {
    const done = s.fields.filter((f) => f.status === 'verified').length;
    const total = s.fields.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const row = (f) => {
      const cls = f.status === 'verified' ? 'ok' : f.status === 'failed' ? 'bad' : f.status === 'needs_user' ? 'warn' : 'todo';
      const icon = f.status === 'verified' ? '✓' : f.status === 'failed' ? '!' : f.status === 'needs_user' ? '●' : '○';
      const note = f.status === 'needs_user' ? ' — needs your answer'
        : f.status === 'failed' ? " — didn't stick"
        : f.status === 'left_blank' ? ' — left blank'
        : f.saveMessage ? ` — ${f.saveMessage}` : '';
      return `<li class="${cls}"><span class="ic">${icon}</span><span class="fname">${escapeHtml(f.label)}${escapeHtml(note)}</span></li>`;
    };
    return `
      <div class="progress">
        <h3>Application progress</h3>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <ul class="fields">${s.fields.map(row).join('')}</ul>
      </div>`;
  }

  reportHtml(report) {
    const bits = [];
    bits.push(`<div class="group"><h3>Final check</h3><ul class="fields">`);
    bits.push(`<li class="ok"><span class="ic">✓</span><span class="fname">${report.filled} field${report.filled === 1 ? '' : 's'} filled and verified</span></li>`);
    if (report.resumeSelected) {
      bits.push(
        report.resumeVerified
          ? `<li class="ok"><span class="ic">✓</span><span class="fname">${escapeHtml(report.resumeFilename || 'Resume')} attached and verified</span></li>`
          : `<li class="bad"><span class="ic">!</span><span class="fname">Resume didn't verify as attached — check the file field</span></li>`,
      );
    }
    if (report.coverLetterFilled) bits.push('<li class="ok"><span class="ic">✓</span><span class="fname">Cover letter filled</span></li>');
    for (const f of report.requiredBlank) bits.push(`<li class="bad"><span class="ic">!</span><span class="fname">${escapeHtml(f.label)} — required, still blank</span></li>`);
    for (const f of report.didNotStick) bits.push(`<li class="bad"><span class="ic">!</span><span class="fname">${escapeHtml(f.label)} — didn't keep the value</span></li>`);
    for (const e of report.validationErrors) bits.push(`<li class="bad"><span class="ic">!</span><span class="fname">${escapeHtml(e.message)}</span></li>`);
    for (const f of report.leftBlank) bits.push(`<li class="warn"><span class="ic">●</span><span class="fname">${escapeHtml(f.label)} — left blank</span></li>`);
    bits.push('</ul></div>');
    return bits.join('');
  }

  wire(s) {
    const $ = (sel) => this.root.querySelector(sel);
    const tab = $('.tab');
    if (tab) tab.addEventListener('click', () => this.open());
    const collapse = $('.collapse');
    if (collapse) collapse.addEventListener('click', () => this.collapse());

    const run = this.root.querySelector('[data-act="run"]');
    if (run) run.addEventListener('click', () => this.agent.run());

    const applied = this.root.querySelector('[data-act="applied"]');
    if (applied) {
      applied.addEventListener('click', async () => {
        applied.disabled = true;
        const res = await this.agent.markApplied();
        applied.textContent = res.ok ? 'Marked applied in ApplyGo' : 'Could not reach ApplyGo';
      });
    }

    // "Update the saved answer" / "Just this once" on a contradiction with what's already stored.
    this.root.querySelectorAll('[data-conflict]').forEach((button) => {
      button.addEventListener('click', () => this.agent.answerPending({ value: button.getAttribute('data-conflict') }));
    });

    // Only ever rendered when the employer's own form marks the field optional -- see agent.js,
    // which re-checks that before accepting this.
    const leaveBlank = this.root.querySelector('[data-leave-blank]');
    if (leaveBlank) leaveBlank.addEventListener('click', () => this.agent.answerPending({ action: 'leave_blank' }));

    // Fixed-choice: the choice itself is Fill; the checkbox above it turns the same click into Save.
    const alsoSave = this.root.querySelector('[data-also-save]');
    this.root.querySelectorAll('[data-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = alsoSave?.checked ? 'save' : 'fill';
        this.agent.answerPending({ action, value: button.getAttribute('data-choice') });
      });
    });

    // Open-ended: Generate drafts into the textarea for the candidate to read and edit; Fill/Save
    // act on whatever is currently typed there, drafted or hand-written.
    const input = this.root.querySelector('[data-input]');
    const generate = this.root.querySelector('[data-generate]');
    const draftNote = this.root.querySelector('[data-draftnote]');
    if (generate) {
      generate.addEventListener('click', async () => {
        generate.disabled = true;
        generate.textContent = 'Drafting…';
        const result = await this.agent.generateDraft(s.pendingQuestion.field);
        generate.disabled = false;
        generate.textContent = 'Generate';
        if (result.ok) {
          if (input) input.value = result.answer;
          if (draftNote) {
            draftNote.textContent = result.grounded
              ? ''
              : "This is a best-effort draft with limited support in your profile — read it closely before using it.";
          }
        } else if (draftNote) {
          draftNote.textContent = "Couldn't draft an answer right now — write your own below.";
        }
      });
    }

    const submitFill = this.root.querySelector('[data-submit-fill]');
    const submitSave = this.root.querySelector('[data-submit-save]');
    const send = (action) => {
      const value = String(input?.value || '').trim();
      if (!value) return;
      this.agent.answerPending({ action, value });
    };
    if (submitFill) submitFill.addEventListener('click', () => send('fill'));
    if (submitSave) submitSave.addEventListener('click', () => send('save'));
    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && input.tagName !== 'TEXTAREA') {
          event.preventDefault();
          send('fill');
        }
      });
      input.focus();
    }
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function escapeAttr(value) {
  return escapeHtml(value);
}

/**
 * Whether this page is worth offering help on. An ATS domain alone isn't enough -- the same host
 * serves the job listing, the search page, and the application itself, and a tab that shows up
 * beside a search box is noise. A real application form has several fields and asks for at least
 * one of the things every application asks for.
 */
function looksLikeApplication() {
  const fields = window.ApplyGoDom.readForm();
  if (fields.length < MIN_FIELDS_TO_OFFER) return false;
  const hasApplicationSignal = fields.some(
    (f) => f.type === 'file' || /\b(e-?mail|first name|last name|full name|resume|cv|phone)\b/i.test(f.label),
  );
  return hasApplicationSignal;
}

(function bootstrap() {
  if (window.top !== window) return;          // never inside an iframe widget
  if (document.getElementById(ROOT_ID)) return;

  const agent = window.ApplyGoAgent;
  const sidebar = new ApplyGoSidebar(agent);
  window.ApplyGoSidebar = sidebar;

  // "Did we already decide this page is worth offering the assistant on" and "is the sidebar's
  // DOM node currently attached" are two different questions. The first is decided once, ever, per
  // page load. The second has to be re-checked continuously: a React rerender can detach
  // #applygo-agent-root at any point after that first decision, with no reload and no signal other
  // than the node quietly falling out of the tree.
  let offered = false;
  async function evaluate() {
    if (!offered) {
      if (!looksLikeApplication()) return;
      offered = true;
      sidebar.prepared = true;
      sidebar.mount();        // collapsed edge tab; opening it is the candidate's choice
      await agent.prepare();
      return;
    }

    // Already offered. From here this only ever reattaches the existing sidebar -- it must not
    // create a second agent or sidebar, and must not reset anything the candidate has done. Also
    // re-checks looksLikeApplication(): if the SPA has navigated somewhere that no longer resembles
    // this application (not just mid-rerender of the same one), the assistant shouldn't reappear
    // on an unrelated page just because it happened to observe a mutation there.
    if (sidebar.host && !sidebar.host.isConnected && looksLikeApplication()) {
      sidebar.ensureMounted();
    }
  }

  // Most ATS forms render after the initial document (and some only after "Apply" is clicked), so
  // this keeps looking rather than deciding once at document_idle -- and, after that, it's what
  // notices and repairs a detach.
  const observer = new MutationObserver(debounce(evaluate, 400));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  evaluate();
})();

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
