/**
 * A developer-only view of every model call the app makes.
 *
 * This is not part of the product. It exists so the prompts can be worked on deliberately: seeing
 * exactly what was sent, what came back, what it cost, and how long it took, grouped by pipeline
 * stage. Guessing at prompt quality from the dashboard's output is how the description-capture bugs
 * survived five rounds of fixes -- the model was answering honestly about text nobody could see.
 *
 * Kept in its own module rather than added to the dashboard because the audiences are different:
 * the dashboard is for finding a job, this is for working on the machine that finds it.
 */

import { LLM_TASKS, taskInfo } from "./tasks";
import { pricedModels, priceFor } from "./llm";

/** How many traces to keep. Past this the oldest are dropped on write. */
export const TRACE_RETENTION = 2000;

export type TraceRow = {
  id: string;
  task: string;
  provider: string;
  model: string;
  tier: string;
  prompt: string;
  response: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  latency_ms: number;
  ok: number;
  error: string | null;
  created_at: string;
};

type Db = D1Database;

/**
 * Per-task rollups over a window, joined onto the registry so a task that has never run still
 * appears. "You have never exercised this prompt" is a finding, not an empty row to hide.
 */
export async function taskRollups(db: Db, days: number): Promise<unknown[]> {
  const rows = await db
    .prepare(
      `SELECT task,
              COUNT(*) AS runs,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures,
              AVG(latency_ms) AS avg_latency_ms,
              SUM(COALESCE(cost_usd, 0)) AS cost_usd,
              SUM(CASE WHEN cost_usd IS NULL AND ok = 1 THEN 1 ELSE 0 END) AS unpriced,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              MAX(created_at) AS last_run_at
       FROM llm_traces
       WHERE created_at >= datetime('now', ?)
       GROUP BY task`,
    )
    .bind(`-${days} days`)
    .all<{
      task: string;
      runs: number;
      failures: number;
      avg_latency_ms: number;
      cost_usd: number;
      unpriced: number;
      input_tokens: number;
      output_tokens: number;
      last_run_at: string;
    }>();

  const byTask = new Map((rows.results ?? []).map((r) => [r.task, r]));

  return LLM_TASKS.map((task) => {
    const stats = byTask.get(task.id);
    return {
      ...task,
      runs: stats?.runs ?? 0,
      failures: stats?.failures ?? 0,
      avg_latency_ms: Math.round(stats?.avg_latency_ms ?? 0),
      cost_usd: stats?.cost_usd ?? 0,
      unpriced: stats?.unpriced ?? 0,
      input_tokens: stats?.input_tokens ?? 0,
      output_tokens: stats?.output_tokens ?? 0,
      last_run_at: stats?.last_run_at ?? null,
    };
  });
}

/**
 * Trace list for the browser. Prompt and response are truncated to previews here -- the full text
 * can be tens of KB per row, and sending 50 of those to render a list is wasteful. The detail
 * endpoint returns them whole.
 */
export async function listTraces(
  db: Db,
  opts: { task?: string; onlyErrors?: boolean; limit: number },
): Promise<unknown[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.task) {
    where.push("task = ?");
    binds.push(opts.task);
  }
  if (opts.onlyErrors) where.push("ok = 0");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await db
    .prepare(
      `SELECT id, task, provider, model, tier, input_tokens, output_tokens, cost_usd,
              latency_ms, ok, error, created_at,
              SUBSTR(prompt, 1, 240) AS prompt_preview,
              SUBSTR(response, 1, 240) AS response_preview,
              LENGTH(prompt) AS prompt_chars,
              LENGTH(response) AS response_chars
       FROM llm_traces ${clause}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(...binds, opts.limit)
    .all();
  return rows.results ?? [];
}

export async function getTrace(db: Db, id: string): Promise<TraceRow | null> {
  return await db.prepare("SELECT * FROM llm_traces WHERE id = ?").bind(id).first<TraceRow>();
}

/**
 * Spend broken out by model, plus an explicit list of models seen in traces that have no price on
 * file. An unpriced model makes every total an undercount, so the console says so rather than
 * quietly reporting a number that is too low.
 */
export async function costSummary(db: Db, days: number): Promise<unknown> {
  const byModel = await db
    .prepare(
      `SELECT model, provider, COUNT(*) AS runs,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(COALESCE(cost_usd, 0)) AS cost_usd,
              SUM(CASE WHEN cost_usd IS NULL AND ok = 1 THEN 1 ELSE 0 END) AS unpriced
       FROM llm_traces WHERE created_at >= datetime('now', ?)
       GROUP BY model, provider ORDER BY cost_usd DESC`,
    )
    .bind(`-${days} days`)
    .all<{ model: string; unpriced: number }>();

  const daily = await db
    .prepare(
      `SELECT DATE(created_at) AS day, SUM(COALESCE(cost_usd, 0)) AS cost_usd, COUNT(*) AS runs
       FROM llm_traces WHERE created_at >= datetime('now', ?)
       GROUP BY day ORDER BY day ASC`,
    )
    .bind(`-${days} days`)
    .all();

  const models = byModel.results ?? [];
  return {
    by_model: models,
    daily: daily.results ?? [],
    unpriced_models: models.filter((m) => !priceFor(m.model)).map((m) => m.model),
    price_table: pricedModels(),
  };
}

/** Everything the console needs to describe one task, including its registry entry. */
export function describeTask(id: string): unknown {
  return taskInfo(id);
}

// The page below is one big template literal. Do not put a backtick anywhere inside it, including
// in comments -- it terminates this string early and breaks the build with an error pointing
// somewhere unrelated. Inner JavaScript uses single quotes and string concatenation throughout.
export const DEV_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ApplyGo -- model calls</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --surface: #f6f7f9; --border: #dfe3e8; --text: #14181d;
    --muted: #626b76; --accent: #2f6feb; --error: #c8372d; --success: #1f7a45;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14181d; --surface: #1c2229; --border: #2c343d; --text: #e8ecf1;
            --muted: #9aa5b1; --accent: #6b9bff; --error: #ff7a6e; --success: #5cc98a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  header { padding: 1rem 1.25rem; border-bottom: 1px solid var(--border);
           display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
  h1 { font-size: 1rem; margin: 0; font-weight: 650; }
  .sub { color: var(--muted); font-size: .8rem; }
  nav { display: flex; gap: .25rem; padding: .5rem 1.25rem 0; border-bottom: 1px solid var(--border); }
  nav button { background: none; border: none; border-bottom: 2px solid transparent; color: var(--muted);
               padding: .5rem .75rem; cursor: pointer; font: inherit; }
  nav button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
  main { padding: 1.25rem; max-width: 1100px; }
  .panel[hidden] { display: none; }
  .controls { display: flex; gap: .5rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
  select, button.action { font: inherit; padding: .3rem .5rem; border: 1px solid var(--border);
                          border-radius: 6px; background: var(--bg); color: var(--text); }
  button.action { cursor: pointer; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--border);
           vertical-align: top; }
  th { color: var(--muted); font-weight: 550; font-size: .78rem; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .stage { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
  .task-name { font-weight: 600; }
  .task-what { color: var(--muted); font-size: .8rem; margin-top: .15rem; }
  .task-src { font-family: var(--mono); font-size: .72rem; color: var(--muted); margin-top: .15rem; }
  .never { color: var(--muted); font-style: italic; }
  .bad { color: var(--error); }
  .good { color: var(--success); }
  .pill { display: inline-block; padding: .05rem .4rem; border-radius: 99px; font-size: .72rem;
          border: 1px solid var(--border); color: var(--muted); }
  .row-click { cursor: pointer; }
  .row-click:hover { background: var(--surface); }
  pre { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
        padding: .75rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
        font-family: var(--mono); font-size: .78rem; max-height: 26rem; overflow-y: auto; }
  .detail { margin-top: 1rem; border-top: 1px solid var(--border); padding-top: 1rem; }
  .detail h3 { font-size: .82rem; margin: 1rem 0 .35rem; color: var(--muted); font-weight: 550; }
  .warn { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--error);
          border-radius: 6px; padding: .6rem .75rem; margin-bottom: 1rem; font-size: .85rem; }
  .empty { color: var(--muted); padding: 1.5rem 0; }
</style>
</head>
<body>
<header>
  <h1>Model calls</h1>
  <span class="sub">Developer view. Every prompt this app sends, what it returned, and what it cost.</span>
</header>
<nav>
  <button data-panel="calls" aria-selected="true">Calls</button>
  <button data-panel="traces" aria-selected="false">Traces</button>
  <button data-panel="costs" aria-selected="false">Cost</button>
</nav>
<main>
  <div class="controls">
    <label>Window
      <select id="days">
        <option value="1">last 24h</option>
        <option value="7" selected>last 7 days</option>
        <option value="30">last 30 days</option>
      </select>
    </label>
    <button class="action" id="refresh">Refresh</button>
    <span class="sub" id="status"></span>
  </div>

  <section class="panel" id="panel-calls">
    <table>
      <thead><tr>
        <th>Call</th><th class="num">Runs</th><th class="num">Failed</th>
        <th class="num">Avg latency</th><th class="num">Tokens in/out</th><th class="num">Cost</th>
      </tr></thead>
      <tbody id="calls-body"></tbody>
    </table>
  </section>

  <section class="panel" id="panel-traces" hidden>
    <div class="controls">
      <label>Call <select id="trace-task"><option value="">all</option></select></label>
      <label><input type="checkbox" id="trace-errors"> failures only</label>
    </div>
    <table>
      <thead><tr>
        <th>When</th><th>Call</th><th>Model</th>
        <th class="num">Latency</th><th class="num">Cost</th><th>Preview</th>
      </tr></thead>
      <tbody id="traces-body"></tbody>
    </table>
    <div id="trace-detail"></div>
  </section>

  <section class="panel" id="panel-costs">
    <div id="cost-warn"></div>
    <h3 style="font-size:.85rem;color:var(--muted);font-weight:550">By model</h3>
    <table>
      <thead><tr><th>Model</th><th>Provider</th><th class="num">Runs</th>
        <th class="num">Tokens in/out</th><th class="num">Cost</th></tr></thead>
      <tbody id="cost-body"></tbody>
    </table>
    <h3 style="font-size:.85rem;color:var(--muted);font-weight:550;margin-top:1.5rem">Per day</h3>
    <table>
      <thead><tr><th>Day</th><th class="num">Calls</th><th class="num">Cost</th></tr></thead>
      <tbody id="daily-body"></tbody>
    </table>
    <h3 style="font-size:.85rem;color:var(--muted);font-weight:550;margin-top:1.5rem">Prices on file (USD per million tokens)</h3>
    <table>
      <thead><tr><th>Model</th><th class="num">Input</th><th class="num">Output</th></tr></thead>
      <tbody id="price-body"></tbody>
    </table>
  </section>
</main>

<script>
(function () {
  var state = { days: 7, task: '', errorsOnly: false, panel: 'calls' };

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function money(value) {
    var n = Number(value || 0);
    if (n === 0) return '$0';
    // Sub-cent totals are normal here: one screen call over 60 postings can cost a fraction of a
    // cent, and rounding those to $0.00 would make the table look broken.
    return n < 0.01 ? '$' + n.toFixed(5) : '$' + n.toFixed(2);
  }
  function ms(value) {
    var n = Number(value || 0);
    return n >= 1000 ? (n / 1000).toFixed(1) + 's' : n + 'ms';
  }
  function when(value) {
    if (!value) return '';
    var d = new Date(String(value).replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  }
  function get(path) {
    return fetch(path, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function setStatus(text) { document.getElementById('status').textContent = text; }

  function renderCalls(tasks) {
    var stage = '';
    var html = '';
    tasks.forEach(function (t) {
      if (t.stage !== stage) {
        stage = t.stage;
        html += '<tr><td colspan="6" class="stage" style="padding-top:1rem">' + esc(stage) + '</td></tr>';
      }
      var failed = t.failures > 0
        ? '<span class="bad">' + t.failures + '</span>'
        : '<span class="good">0</span>';
      html += '<tr>' +
        '<td><div class="task-name">' + esc(t.name) +
          ' <span class="pill">' + esc(t.tier) + '</span>' +
          (t.batched ? ' <span class="pill">batched</span>' : '') + '</div>' +
          '<div class="task-what">' + esc(t.what) + '</div>' +
          '<div class="task-src">' + esc(t.source) + ' &middot; ' + esc(t.id) + '</div></td>' +
        '<td class="num">' + (t.runs ? t.runs : '<span class="never">never run</span>') + '</td>' +
        '<td class="num">' + (t.runs ? failed : '') + '</td>' +
        '<td class="num">' + (t.runs ? ms(t.avg_latency_ms) : '') + '</td>' +
        '<td class="num">' + (t.runs ? (t.input_tokens + ' / ' + t.output_tokens) : '') + '</td>' +
        '<td class="num">' + (t.runs ? money(t.cost_usd) +
          (t.unpriced ? ' <span class="bad" title="calls on a model with no price on file">+' + t.unpriced + '?</span>' : '') : '') + '</td>' +
      '</tr>';
    });
    document.getElementById('calls-body').innerHTML = html;
  }

  function renderTraces(rows) {
    if (!rows.length) {
      document.getElementById('traces-body').innerHTML =
        '<tr><td colspan="6" class="empty">No calls recorded yet. Run a scan or a fit pass and come back.</td></tr>';
      return;
    }
    var html = '';
    rows.forEach(function (r) {
      var preview = r.ok ? r.response_preview : r.error;
      html += '<tr class="row-click" data-trace="' + esc(r.id) + '">' +
        '<td>' + esc(when(r.created_at)) + '</td>' +
        '<td>' + esc(r.task) + (r.ok ? '' : ' <span class="bad">failed</span>') + '</td>' +
        '<td>' + esc(r.model) + '</td>' +
        '<td class="num">' + ms(r.latency_ms) + '</td>' +
        '<td class="num">' + (r.cost_usd === null ? '<span class="bad">?</span>' : money(r.cost_usd)) + '</td>' +
        '<td style="max-width:26rem;color:var(--muted)">' + esc(String(preview || '').slice(0, 140)) + '</td>' +
      '</tr>';
    });
    document.getElementById('traces-body').innerHTML = html;
  }

  function renderDetail(t) {
    var head = '<div class="detail"><strong>' + esc(t.task) + '</strong> &middot; ' +
      esc(t.provider) + ' / ' + esc(t.model) + ' &middot; ' + esc(t.tier) + ' &middot; ' +
      ms(t.latency_ms) + ' &middot; ' + t.input_tokens + ' in / ' + t.output_tokens + ' out &middot; ' +
      (t.cost_usd === null ? '<span class="bad">unpriced model</span>' : money(t.cost_usd)) +
      ' &middot; ' + esc(when(t.created_at));
    if (!t.ok) head += '<div class="warn" style="margin-top:.6rem">' + esc(t.error) + '</div>';
    head += '<h3>Prompt (' + String(t.prompt || '').length + ' chars)</h3><pre>' + esc(t.prompt) + '</pre>';
    head += '<h3>Response</h3><pre>' + esc(t.response || '(none)') + '</pre></div>';
    document.getElementById('trace-detail').innerHTML = head;
    document.getElementById('trace-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderCosts(data) {
    var warn = '';
    if (data.unpriced_models.length) {
      warn = '<div class="warn">No price on file for: <strong>' +
        data.unpriced_models.map(esc).join(', ') +
        '</strong>. Totals below exclude these calls and are an undercount. Add them to PRICING in src/llm.ts.</div>';
    }
    document.getElementById('cost-warn').innerHTML = warn;

    document.getElementById('cost-body').innerHTML = data.by_model.length
      ? data.by_model.map(function (m) {
          return '<tr><td>' + esc(m.model) + '</td><td>' + esc(m.provider) + '</td>' +
            '<td class="num">' + m.runs + '</td>' +
            '<td class="num">' + m.input_tokens + ' / ' + m.output_tokens + '</td>' +
            '<td class="num">' + (m.unpriced ? '<span class="bad">unpriced</span>' : money(m.cost_usd)) + '</td></tr>';
        }).join('')
      : '<tr><td colspan="5" class="empty">Nothing recorded in this window.</td></tr>';

    document.getElementById('daily-body').innerHTML = data.daily.map(function (d) {
      return '<tr><td>' + esc(d.day) + '</td><td class="num">' + d.runs + '</td>' +
        '<td class="num">' + money(d.cost_usd) + '</td></tr>';
    }).join('');

    document.getElementById('price-body').innerHTML = data.price_table.map(function (p) {
      return '<tr><td>' + esc(p.model) + '</td><td class="num">$' + p['in'] + '</td>' +
        '<td class="num">$' + p.out + '</td></tr>';
    }).join('');
  }

  function loadCalls() {
    return get('/dev/tasks?days=' + state.days).then(function (data) {
      renderCalls(data.tasks);
      var sel = document.getElementById('trace-task');
      if (sel.options.length <= 1) {
        data.tasks.forEach(function (t) {
          var opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = t.name;
          sel.appendChild(opt);
        });
      }
    });
  }
  function loadTraces() {
    var q = '/dev/traces?limit=60' + (state.task ? '&task=' + encodeURIComponent(state.task) : '') +
      (state.errorsOnly ? '&errors=1' : '');
    return get(q).then(function (data) { renderTraces(data.traces); });
  }
  function loadCosts() {
    return get('/dev/costs?days=' + state.days).then(renderCosts);
  }

  function refresh() {
    setStatus('Loading...');
    var jobs = [loadCalls()];
    if (state.panel === 'traces') jobs.push(loadTraces());
    if (state.panel === 'costs') jobs.push(loadCosts());
    Promise.all(jobs).then(function () { setStatus(''); })
      .catch(function (err) { setStatus('Failed: ' + err.message); });
  }

  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (btn) {
    btn.addEventListener('click', function () {
      state.panel = btn.getAttribute('data-panel');
      Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) {
        b.setAttribute('aria-selected', String(b === btn));
      });
      ['calls', 'traces', 'costs'].forEach(function (name) {
        document.getElementById('panel-' + name).hidden = name !== state.panel;
      });
      refresh();
    });
  });

  document.getElementById('days').addEventListener('change', function (e) {
    state.days = Number(e.target.value); refresh();
  });
  document.getElementById('refresh').addEventListener('click', refresh);
  document.getElementById('trace-task').addEventListener('change', function (e) {
    state.task = e.target.value; loadTraces();
  });
  document.getElementById('trace-errors').addEventListener('change', function (e) {
    state.errorsOnly = e.target.checked; loadTraces();
  });
  document.getElementById('traces-body').addEventListener('click', function (e) {
    var row = e.target.closest('[data-trace]');
    if (!row) return;
    get('/dev/traces/' + encodeURIComponent(row.getAttribute('data-trace')))
      .then(function (data) { renderDetail(data.trace); });
  });

  refresh();
})();
</script>
</body>
</html>`;
