// The application agent.
//
// This is an orchestrator, not a prompt. It owns a structured picture of the application and
// decides what happens next; the model is consulted only where interpretation actually adds value,
// and never for anything the system already knows. The resolution order the agent works down is:
//
//   1. job-specific answers the candidate gave for this exact job
//   2. explicit saved answers (the answer bank)
//   3. deterministic profile facts (name, email, phone, LinkedIn)
//   4. the tailored resume / cover letter prepared in the main app
//   5. ask the candidate -- offering an on-demand model draft for open-ended fields evidence
//      actually supports, never for sensitive personal/legal facts (see NEVER_INFER server-side)
//
// Steps 1-4 are lookups and cost nothing. Deciding that "Jason" goes in the first-name field is not
// a reasoning problem and never becomes one. Steps 1-4 happen inside /applications/match on the
// Worker (it holds the profile); a draft for step 5 is its own on-demand call
// (/applications/generate-answer) that only ever lands in the sidebar's editable input, never
// straight into the employer's form -- the candidate reviews or edits it, then chooses Fill (use
// now only) or Save (use now and remember, scoped per the backend's classification). There is no
// automatic model pass and no Skip: a field stays visibly outstanding until it's filled, saved, or
// -- only when the employer's own form marks it optional -- explicitly left blank.
//
// Every browser mutation goes through the fixed tool set below, which is deliberately small. The
// agent can fill a field it was told to fill; it cannot navigate, click arbitrary things, or submit.

const CADENCE_MS = 70;        // between fields: enough to follow, not enough to be slow
const MAX_PLAN_ROUNDS = 3;    // dynamic forms settle well within this; the cap stops a loop

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiCall(path, method, body) {
  return chrome.runtime.sendMessage({ type: 'API', path, method, body });
}

class ApplicationAgent {
  constructor() {
    this.reset();
    this.listeners = [];
  }

  reset() {
    /** The structured application state the agent reasons over (see spec: state, not a transcript). */
    this.state = {
      jobId: null,
      job: null,
      applicationUrl: typeof location !== 'undefined' ? location.href : '',
      status: 'idle',
      statusText: '',
      shiba: 'ready',
      fields: [],
      pendingQuestion: null,
      review: [],
      validationErrors: [],
      assets: { resume: false, coverLetter: false },
      finalReport: null,
      round: 0,
      connected: false,
      apiBase: '',
    };
    this.events = [];
    this.pendingResolver = null;
  }

  onUpdate(fn) {
    this.listeners.push(fn);
  }

  notify() {
    for (const fn of this.listeners) fn(this.state);
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.notify();
  }

  /** The audit trail (§27): what was decided and why, never the value of a sensitive answer. */
  record(type, field, detail) {
    this.events.push({ type, field: field || '', detail: detail || {} });
  }

  async flushEvents() {
    if (!this.events.length) return;
    const events = this.events.splice(0, this.events.length);
    await apiCall('/applications/events', 'POST', {
      job_id: this.state.jobId,
      application_url: this.state.applicationUrl,
      events,
    }).catch(() => null);
  }

  // -------------------------------------------------------------------------
  // Tools. The complete set of actions the agent may take on the page.
  // -------------------------------------------------------------------------
  get tools() {
    const dom = window.ApplyGoDom;
    return {
      inspect_page: () => ({ url: dom.pageUrl(), fields: dom.readForm() }),
      list_visible_fields: () => dom.readForm(),
      scroll_to_field: (name) => dom.scrollToField(name),
      highlight_field: (name, on) => dom.highlightField(name, on),
      fill_field: (name, value) => dom.fillField(name, value),
      verify_field: (name, expected) => dom.verifyField(name, expected),
      mark_missing: (name) => dom.markMissing(name),
      mark_result: (name, ok) => dom.markResult(name, ok),
      upload_resume: (base64, filename) => dom.attachResumeFromBase64(base64, filename),
      verify_resume: (filename) => dom.verifyResumeAttached(filename),
      fill_cover_letter: (text) => dom.fillCoverLetter(text),
      read_validation_errors: () => dom.readValidationErrors(),
      discover_combobox_options: (name) => dom.discoverComboboxOptions(name),
      ask_user: (question) => this.askUser(question),
      save_answer: (payload) => apiCall('/applications/answer', 'POST', payload),
      generate_answer: (payload) => apiCall('/applications/generate-answer', 'POST', payload),
      resolve_option: (payload) => apiCall('/applications/resolve-option', 'POST', payload),
      report_completion: (report) => this.set({ status: 'complete', shiba: 'done', finalReport: report }),
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Cheap first pass: is this a form worth offering help on, and are we connected? */
  async prepare() {
    const status = await chrome.runtime.sendMessage({ type: 'API_STATUS' }).catch(() => null);
    // apiBase turns the resume's relative /resumes/:id/file path into something the sidebar can
    // actually open in a new tab for "which resume is this?" preview (see attachAssets/reportHtml).
    this.set({ connected: Boolean(status?.connected), apiBase: status?.apiBase || '' });
    if (!status?.connected) return;

    const job = await this.matchJobForUrl();
    this.set({
      jobId: job ? job.id : null,
      job: job ? { title: job.title, company: job.company } : null,
      statusText: job
        ? `Ready to help with your ${job.title} application.`
        : "I don't recognize this job from ApplyGo, but I can still fill what I know about you.",
    });
  }

  /**
   * Finds the ApplyGo job whose posting URL matches this tab, so the tailored resume, cover letter
   * and job-specific answers for *that* job are the ones used. Matching on URL rather than asking
   * keeps the handoff from the Apply button to a single click.
   */
  async matchJobForUrl() {
    const res = await apiCall('/jobs', 'GET');
    if (!res?.ok || !res.data?.jobs) return null;
    const normalize = (u) => String(u || '').split('?')[0].replace(/\/+$/, '');
    const here = normalize(this.state.applicationUrl);
    const jobs = res.data.jobs.filter((j) => j.source_url);
    return (
      jobs.find((j) => normalize(j.source_url) === here) ||
      // Application pages often hang off the posting URL (".../jobs/123/apply"), so a prefix counts.
      jobs.find((j) => here.startsWith(normalize(j.source_url))) ||
      jobs.find((j) => normalize(j.source_url).startsWith(here)) ||
      null
    );
  }

  /** The whole run: plan, execute, adapt to what the page does, ask what's left, review. */
  async run() {
    if (this.state.status === 'working' || this.state.status === 'waiting_user') return;
    this.set({ status: 'planning', shiba: 'thinking', statusText: 'Reading the application…', finalReport: null });

    try {
      for (let round = 0; round < MAX_PLAN_ROUNDS; round++) {
        this.set({ round: round + 1 });
        const planned = await this.planRound(round === 0);
        if (!planned) break;
        // A form that reveals fields as you answer (selecting a country exposing a legal question,
        // uploading a resume auto-populating contact details) has to be re-read, not assumed.
        const changed = await this.rescan();
        if (!changed) break;
      }

      await this.askOutstanding();
      await this.finalReview();
    } catch (err) {
      this.set({ status: 'error', shiba: 'attention', statusText: 'Something went wrong: ' + (err.message || err) });
      this.record('run_failed', '', { message: String(err.message || err) });
    } finally {
      await this.flushEvents();
    }
  }

  /** One plan-and-execute pass over whatever is currently on the page. */
  async planRound(includeAssets) {
    const fields = this.tools.list_visible_fields();
    if (!fields.length) {
      this.set({ status: 'error', shiba: 'attention', statusText: "I can't find a form on this page." });
      return false;
    }

    // Only fields we haven't triaged yet. A field already resolved, or already known to need the
    // candidate, must not go back through the model on the next round -- that's a paid call to be
    // told the same thing twice, and on a dynamic form there can be several rounds.
    const known = new Set(this.state.fields.map((f) => f.name));
    const todo = fields.filter((f) => !known.has(f.name) && !f.filled);
    if (!todo.length) return false;

    this.set({ status: 'planning', shiba: 'thinking', statusText: `Working out ${todo.length} field${todo.length === 1 ? '' : 's'}…` });
    const res = await apiCall('/applications/match', 'POST', { job_id: this.state.jobId, fields: todo });
    if (!res?.ok) {
      const reason = res?.error === 'not_connected' ? 'ApplyGo isn\'t connected on this browser.' : (res?.error || 'match failed');
      throw new Error(reason);
    }
    const plan = res.data || {};
    this.record('plan_received', '', {
      round: this.state.round,
      answered: (plan.answers || []).length,
      unresolved: (plan.missing || []).length,
    });

    if (plan.job && !this.state.job) this.set({ job: { title: plan.job.title, company: plan.job.company } });
    if (plan.assets) this.set({ assets: { resume: plan.assets.resume, coverLetter: plan.assets.cover_letter } });

    this.mergeFields(todo, plan);
    await this.executeAnswers(plan.answers || []);
    if (includeAssets) await this.attachAssets(plan);
    return true;
  }

  /** Folds this round's plan into the structured per-field record the UI reads. */
  mergeFields(todo, plan) {
    const answers = new Map((plan.answers || []).map((a) => [a.name, a]));
    const missing = new Map((plan.missing || []).map((m) => [m.name, m]));
    const next = [...this.state.fields];
    for (const field of todo) {
      const answer = answers.get(field.name);
      const gap = missing.get(field.name);
      const record = {
        name: field.name,
        label: field.label,
        type: field.type,
        options: field.options || [],
        required: Boolean(field.required),
        maxLength: field.maxLength || gap?.max_length || null,
        status: answer ? 'planned' : 'needs_user',
        source: answer ? answer.source : null,
        confidence: answer ? answer.confidence : null,
        value: answer ? answer.value : '',
        reason: gap ? gap.reason : null,
        sensitive: gap ? gap.reason === 'sensitive' : false,
        category: gap ? gap.category : null,
        canGenerate: gap ? Boolean(gap.can_generate) : false,
      };
      const at = next.findIndex((f) => f.name === field.name);
      if (at >= 0) next[at] = record;
      else next.push(record);
    }
    this.set({ fields: next });
  }

  /**
   * Fills planned answers one at a time so the candidate can watch it happen, verifying each before
   * moving on. A field whose value didn't survive is marked failed rather than counted as done --
   * that's the difference between "filled 24 fields" and "filled 24 fields that are actually there".
   */
  async executeAnswers(answers) {
    this.set({ status: 'working', shiba: 'working' });
    for (const answer of answers) {
      const field = this.state.fields.find((f) => f.name === answer.name);
      const label = field?.label || answer.name;
      this.set({ statusText: `Filling ${label}` });

      this.tools.scroll_to_field(answer.name);
      this.tools.highlight_field(answer.name, true);
      const { check, value } = await this.fillAndVerify(field, answer.value);
      await delay(CADENCE_MS);

      this.tools.highlight_field(answer.name, false);
      // The outline only ever turns green or red here, after verify_field has actually looked --
      // never at the moment of the fill attempt, which is what let a dropdown that silently didn't
      // stick still get painted as done.
      this.tools.mark_result(answer.name, check.ok);
      this.updateField(answer.name, {
        status: check.ok ? 'verified' : 'failed',
        value,
        verifyReason: check.ok ? null : check.reason || 'not_accepted',
      });
      this.record(check.ok ? 'field_filled' : 'field_fill_failed', answer.name, {
        label,
        source: answer.source,
        confidence: answer.confidence,
        reason: check.ok ? undefined : check.reason,
      });
    }
  }

  /**
   * Fills a field and verifies it, retrying once via model-assisted option resolution when a
   * direct fill fails for a fixed-choice field with real options. content.js's own fast, rule-
   * based matching (findOptionMatch) handles the great majority of cases; this exists for the
   * remainder, where a decorated option ("United States+1", not "United States") or an
   * unanticipated phrasing defeats a plain synonym table without being genuinely ambiguous to a
   * reasoning pass over the employer's own real list. Never asked to invent a choice -- the model
   * picks from the exact options given, and re-checks server-side that it did; a field this can't
   * confidently resolve either way falls through to asking the candidate exactly as it already
   * would have. Returns the value that actually ended up being used, which can differ from what
   * was passed in when resolution substituted the matching option text.
   */
  async fillAndVerify(field, value) {
    let filled = await this.tools.fill_field(field.name, value);
    let check = filled ? this.tools.verify_field(field.name, value) : { ok: false, reason: 'fill_failed' };
    let usedValue = value;

    const isChoiceField = field && (field.type === 'radio' || field.type === 'select') && (field.options || []).length > 0;
    if (!check.ok && isChoiceField) {
      const resolved = await this.tools.resolve_option({ label: field.label, value, options: field.options });
      if (resolved?.ok && resolved.data?.confident && resolved.data?.option) {
        this.record('option_resolved', field.name, { to: resolved.data.option });
        usedValue = resolved.data.option;
        filled = await this.tools.fill_field(field.name, usedValue);
        check = filled ? this.tools.verify_field(field.name, usedValue) : { ok: false, reason: 'fill_failed' };
      } else if (resolved && resolved.ok === false) {
        this.record('option_resolve_failed', field.name, { error: resolved.error });
      }
    }
    return { check, value: usedValue };
  }

  updateField(name, patch) {
    const next = this.state.fields.map((f) => (f.name === name ? { ...f, ...patch } : f));
    this.set({ fields: next });
  }

  /**
   * The resume and cover letter the main app already prepared for this job. The resume goes
   * through three distinct claims, never collapsed into one "attached" boolean: selected (ApplyGo
   * has a tailored resume for this job), attached (a File object was constructed and set on the
   * employer's input), and verified (reading the input back confirms it's actually there). Only
   * "verified" is what makes Application Progress call this done.
   */
  async attachAssets(plan) {
    if (plan.resume_url) {
      const filename = plan.resume_filename || 'Resume.pdf';
      this.set({
        statusText: `Attaching ${filename}…`,
        assets: { ...this.state.assets, resumeUrl: plan.resume_url, resumeFilename: filename, resumeAttached: false, resumeVerified: false },
      });
      const file = await chrome.runtime.sendMessage({ type: 'API_RESUME', path: plan.resume_url }).catch(() => null);
      if (file?.ok) {
        const result = this.tools.upload_resume(file.base64, filename);
        this.record(result.ok ? 'resume_attached' : 'resume_attach_failed', result.name || '', { reason: result.reason, filename });
        let verified = false;
        if (result.ok) {
          const check = this.tools.verify_resume(filename);
          verified = check.ok;
          this.record(check.ok ? 'resume_verified' : 'resume_verify_failed', result.name || '', { reason: check.reason });
        }
        this.set({ assets: { ...this.state.assets, resumeAttached: result.ok, resumeVerified: verified } });
      } else {
        this.record('resume_attach_failed', '', { reason: 'download_failed', filename });
      }
    }
    if (plan.cover_letter_text) {
      const result = this.tools.fill_cover_letter(plan.cover_letter_text);
      this.record(result.ok ? 'cover_letter_filled' : 'cover_letter_skipped', result.name || '', { reason: result.reason });
      this.set({ assets: { ...this.state.assets, coverLetterFilled: result.ok } });
    }
  }

  /** Did answering things change the form? Returns true when there's genuinely more to plan. */
  async rescan() {
    this.set({ statusText: 'Checking whether the form changed…', shiba: 'thinking' });
    await delay(180); // give the page's own handlers a beat to render whatever they reveal
    const fields = this.tools.list_visible_fields();
    const known = new Set(this.state.fields.map((f) => f.name));
    const appeared = fields.filter((f) => !known.has(f.name) && !f.filled);
    const disappeared = this.state.fields.filter((f) => !fields.some((v) => v.name === f.name));
    if (disappeared.length) {
      this.set({ fields: this.state.fields.filter((f) => fields.some((v) => v.name === f.name)) });
    }
    if (appeared.length || disappeared.length) {
      this.record('page_rescanned', '', { appeared: appeared.length, disappeared: disappeared.length });
    }
    return appeared.length > 0;
  }

  // -------------------------------------------------------------------------
  // Asking
  // -------------------------------------------------------------------------

  /** Suspends the run and hands a question to the sidebar; resolves when the candidate answers. */
  askUser(question) {
    this.set({ status: 'waiting_user', shiba: 'asking', pendingQuestion: question, statusText: question.prompt || '' });
    return new Promise((resolve) => {
      this.pendingResolver = resolve;
    });
  }

  /**
   * Called by the sidebar with a structured action rather than a bare value: `{action:'fill'|'save',
   * value}` for a field question, `{action:'leave_blank'}` for an optional field, or `{value:
   * 'update'|'keep'}` for a conflict question. There is no "empty submission" shape any more --
   * leaving a field alone is now its own explicit choice, not a value the candidate forgot to type.
   */
  answerPending(payload) {
    const resolver = this.pendingResolver;
    this.pendingResolver = null;
    this.set({ pendingQuestion: null });
    if (resolver) resolver(payload || {});
  }

  /**
   * One draft for one open-ended field, on demand. Does not resolve the pending question -- the
   * sidebar places the returned text in its editable textarea for the candidate to read and edit,
   * then the candidate still has to choose Fill or Save themselves (see spec: "Generate -> review/
   * edit -> Fill or Save").
   */
  async generateDraft(field) {
    const res = await this.tools.generate_answer({
      job_id: this.state.jobId,
      field: { name: field.name, label: field.label, type: field.type, max_length: field.maxLength || null },
    });
    if (!res?.ok) {
      this.record('generate_failed', field.name, { error: res?.error });
      return { ok: false, error: res?.error || 'generate_failed' };
    }
    this.record('answer_generated', field.name, { grounded: Boolean(res.data?.grounded) });
    return { ok: true, answer: res.data?.answer || '', grounded: Boolean(res.data?.grounded) };
  }

  /** Everything the agent legitimately could not answer, asked one at a time. */
  async askOutstanding() {
    const outstanding = () => this.state.fields.filter((f) => f.status === 'needs_user' || f.status === 'failed');
    const toAsk = outstanding();
    if (toAsk.length) {
      // Amber goes on every outstanding field up front, not just the one currently being asked --
      // a candidate scrolling ahead should see at a glance which fields still need them, the same
      // way a required-but-blank field reads at final review.
      for (const field of toAsk) this.tools.mark_missing(field.name);
      this.set({ statusText: 'I found a few questions I need your help with.' });
    }
    let guard = 0;
    while (outstanding().length && guard++ < 40) {
      let field = outstanding()[0];

      // Re-read the live DOM right before asking, not just at plan time: a field triaged a round or
      // two ago may have had its real option list rendered late by the employer's own JS (a country
      // picker whose choices populate after the page settles), and asking from a stale record is how
      // "sometimes shows real options, sometimes doesn't" happens.
      const live = this.tools.list_visible_fields().find((f) => f.name === field.name);
      if (live) {
        field = {
          ...field,
          label: live.label || field.label,
          // An empty live read doesn't necessarily mean the options went away -- it can just mean the
          // employer's JS hasn't populated them on this pass yet, so an empty result never clobbers a
          // real list from an earlier read.
          options: live.options && live.options.length ? live.options : field.options,
          maxLength: live.maxLength ?? field.maxLength,
          type: live.type || field.type,
        };
        this.updateField(field.name, { label: field.label, options: field.options, maxLength: field.maxLength, type: field.type });
      }

      // A select-type field with no options yet is very likely a styled combobox (react-select and
      // most similar libraries) whose real choices only exist once it's actually opened -- worth
      // trying right here, since this is a single, visible interaction on the one field the
      // candidate is about to be asked to answer, not a silent sweep opening every dropdown on the
      // page.
      if (field.type === 'select' && !(field.options || []).length) {
        const discovered = await this.tools.discover_combobox_options(field.name);
        if (discovered.length) {
          field = { ...field, options: discovered };
          this.updateField(field.name, { options: discovered });
        }
      }

      this.tools.scroll_to_field(field.name);
      this.tools.highlight_field(field.name, true);

      const answer = await this.tools.ask_user({
        kind: 'field',
        field,
        prompt: this.explainWhyAsking(field),
      });
      this.tools.highlight_field(field.name, false);

      if (answer?.action === 'leave_blank') {
        // Only ever offered by the sidebar for a field the employer's own form marks optional --
        // enforced there, checked again here since this is the actual safeguard against a required
        // field silently going unfilled.
        if (field.required) continue;
        this.updateField(field.name, { status: 'left_blank' });
        this.record('field_left_blank', field.name, { label: field.label });
        continue;
      }

      const value = String(answer?.value ?? '').trim();
      if (!value) continue; // nothing usable submitted -- stays outstanding, the guard prevents a stall

      if (answer.action === 'save') await this.fillAndSave(field, value);
      else await this.fillOnly(field, value);
    }
  }

  /**
   * Why the candidate is being asked, in their terms. The distinction matters: "I won't guess this"
   * is a deliberate safeguard and should read as one, not as the assistant failing to cope.
   */
  explainWhyAsking(field) {
    if (field.sensitive) {
      return `This one's personal and consequential, so I won't guess it.`;
    }
    // "I don't know the answer" and "I know the answer but couldn't operate this control" are
    // different problems with different fixes -- collapsing them into one generic message is how a
    // dropdown-interaction bug gets mistaken for a missing answer.
    if (field.status === 'failed' && field.value) {
      return `I know your answer here is "${field.value}", but the form didn't accept it when I tried. Can you set it yourself?`;
    }
    if (field.status === 'failed') {
      return `I tried to fill this but the form didn't keep the value. What should it say?`;
    }
    if (field.canGenerate) {
      return `I don't have a verified answer saved for this, but I can draft one using your profile and this job.`;
    }
    return `I don't have a verified answer for this yet.`;
  }

  /** Fill: use the candidate's answer on this application only. No backend write except the audit event. */
  async fillOnly(field, value) {
    const { check, value: usedValue } = await this.fillAndVerify(field, value);
    this.tools.mark_result(field.name, check.ok);
    this.updateField(field.name, {
      status: check.ok ? 'verified' : 'failed',
      source: 'user',
      confidence: 'high',
      value: usedValue,
      verifyReason: check.ok ? null : check.reason,
      saveMessage: null,
    });
    this.record(check.ok ? 'field_filled' : 'field_fill_failed', field.name, { source: 'user', saved: false });
  }

  /**
   * Save: use now and remember, scoped per the backend's classification (global bank, job-specific,
   * or declined -- see saveApplicationAgentAnswer). Handles a contradiction with an existing saved
   * answer before writing anything; the candidate's current answer always fills this application
   * either way, the stored record only changes if they say so.
   */
  async fillAndSave(field, value, confirmOverwrite) {
    const payload = {
      question: field.label,
      answer: value,
      answer_type: field.type,
      job_id: this.state.jobId,
      ...(confirmOverwrite ? { confirm_overwrite: true } : {}),
    };
    const res = await this.tools.save_answer(payload);
    const data = res?.data || {};

    if (data.conflict) {
      const choice = await this.tools.ask_user({
        kind: 'conflict',
        field,
        value,
        conflict: data.conflict,
        prompt: `I had "${data.conflict.existing_answer}" saved for this. Should I update it to "${value}"?`,
      });
      this.record('contradiction_detected', field.name, { label: field.label });
      if (choice?.value === 'update') {
        await this.fillAndSave(field, value, true);
      } else {
        this.record('saved_answer_kept', field.name, {});
        await this.fillOnly(field, value);
      }
      return;
    }

    this.record('answer_stored', field.name, { storage: data.storage, category: data.category, stored: data.stored });
    const { check, value: usedValue } = await this.fillAndVerify(field, value);
    this.tools.mark_result(field.name, check.ok);
    this.updateField(field.name, {
      status: check.ok ? 'verified' : 'failed',
      source: 'user',
      confidence: 'high',
      value: usedValue,
      verifyReason: check.ok ? null : check.reason,
      saveMessage: data.stored ? data.message : null,
    });
    this.record(check.ok ? 'field_filled' : 'field_fill_failed', field.name, { source: 'user', saved: Boolean(data.stored) });
  }

  // -------------------------------------------------------------------------
  // Review
  // -------------------------------------------------------------------------

  /**
   * The last pass before handing back. Everything checked here is something that would otherwise be
   * discovered by the employer's own validation after the candidate hits submit.
   */
  async finalReview() {
    this.set({ status: 'reviewing', shiba: 'thinking', statusText: 'Checking the finished form…' });
    await delay(160);

    // Application Progress and Final Check must never disagree: every field this session currently
    // believes is "verified" gets re-verified against the live DOM right now, not trusted from
    // whenever it was originally filled. A multi-step form, the employer's own JS, or a later field
    // interacting with this one can all quietly revert a value after the fact -- final validation is
    // authoritative, so a field that regressed loses its checkmark and its green outline here, before
    // either view is ever shown, rather than the two views silently disagreeing.
    let regressed = 0;
    const reconciled = this.state.fields.map((field) => {
      if (field.status !== 'verified') return field;
      const recheck = this.tools.verify_field(field.name, field.value);
      if (recheck.ok) return field;
      regressed++;
      this.tools.mark_result(field.name, false);
      this.record('field_regressed', field.name, { label: field.label, reason: recheck.reason });
      return { ...field, status: 'failed', verifyReason: recheck.reason || 'regressed' };
    });
    if (regressed) this.set({ fields: reconciled });

    const live = this.tools.list_visible_fields();
    const validationErrors = this.tools.read_validation_errors();
    const requiredBlank = live.filter((f) => f.required && !f.filled);
    const didNotStick = reconciled.filter((f) => f.status === 'failed');
    const leftBlank = reconciled.filter((f) => f.status === 'left_blank');
    const filledCount = reconciled.filter((f) => f.status === 'verified').length;

    for (const field of requiredBlank) this.tools.mark_missing(field.name);

    // A resume that was supposed to attach but never verified as actually there is exactly the kind
    // of "ApplyGo thinks it's done but it isn't" gap this whole review exists to catch -- it counts
    // toward outstanding the same way a dropdown that didn't stick does.
    const resumeSelected = Boolean(this.state.assets.resume);
    const resumeVerified = Boolean(this.state.assets.resumeVerified);
    const resumeIncomplete = resumeSelected && !resumeVerified;

    const outstanding = requiredBlank.length + didNotStick.length + validationErrors.length + (resumeIncomplete ? 1 : 0);
    const report = {
      filled: filledCount,
      requiredBlank: requiredBlank.map((f) => ({ name: f.name, label: f.label })),
      didNotStick: didNotStick.map((f) => ({ name: f.name, label: f.label })),
      leftBlank: leftBlank.map((f) => ({ name: f.name, label: f.label })),
      validationErrors,
      resumeSelected,
      resumeAttached: Boolean(this.state.assets.resumeAttached),
      resumeVerified,
      resumeFilename: this.state.assets.resumeFilename || null,
      coverLetterFilled: Boolean(this.state.assets.coverLetterFilled),
      clean: outstanding === 0,
    };

    this.set({ validationErrors });
    this.record('final_review', '', {
      filled: filledCount,
      required_blank: requiredBlank.length,
      did_not_stick: didNotStick.length,
      validation_errors: validationErrors.length,
      regressed,
    });

    // Never submits. The candidate reads it over and presses the employer's own button.
    this.tools.report_completion(report);
    this.set({
      shiba: report.clean ? 'done' : 'attention',
      statusText: report.clean
        ? 'Everything I filled is now verified. Give it a quick review, then submit when you\'re ready.'
        : regressed
          ? 'I thought this was complete, but the application is still flagging it. I need to fix it.'
          : 'I filled what I could, but a few things still need you.',
    });
  }

  /** Mark the ApplyGo job applied, once the candidate says they submitted it. */
  async markApplied() {
    if (!this.state.jobId) return { ok: false };
    const res = await apiCall(`/jobs/${encodeURIComponent(this.state.jobId)}/fit`, 'PATCH', { action: 'applied' });
    this.record('marked_applied', '', { ok: Boolean(res?.ok) });
    await this.flushEvents();
    return { ok: Boolean(res?.ok) };
  }
}

window.ApplyGoAgent = new ApplicationAgent();
