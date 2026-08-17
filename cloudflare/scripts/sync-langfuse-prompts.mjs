#!/usr/bin/env node
/**
 * Pushes the repository's bundled prompt texts into Langfuse Prompt Management.
 *
 * `src/prompts.ts` is already a structured registry: it maps each Langfuse prompt name to its
 * canonical text plus the `requires` list naming the variables a template must reference to count
 * as current. That is everything needed to make synchronization deterministic instead of a manual
 * copy-paste job, which is what this script does.
 *
 * The rule it implements is the same one `getManagedPrompt` applies at runtime: a live prompt whose
 * template references none of its `requires` variables is stale, and the repository's version is
 * the one that should be live. So by default this only pushes prompts that are missing or stale —
 * running it when everything is in sync makes no writes at all and is safe to repeat.
 *
 *   node scripts/sync-langfuse-prompts.mjs                # report what would change, write nothing
 *   node scripts/sync-langfuse-prompts.mjs --apply        # create/update the ones that need it
 *   node scripts/sync-langfuse-prompts.mjs --apply --all  # also re-push prompts already current
 *   node scripts/sync-langfuse-prompts.mjs --apply --only cover_letter/compose
 *
 * Credentials come from the environment (or `.env` / `.dev.vars`, which are gitignored):
 * LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL. Nothing is written to source
 * control and no key is ever printed.
 *
 * A new version is created with the `production` label, matching how the runtime fetches prompts.
 * Langfuse keeps every previous version, so a bad push is rolled back by re-promoting the old one
 * in the UI rather than by anything here.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const all = args.includes("--all");
const onlyIndex = args.indexOf("--only");
const only = onlyIndex !== -1 ? args[onlyIndex + 1] : null;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Reads KEY=value files (.env, .dev.vars) without adding a dotenv dependency. */
function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const fileEnv = { ...loadEnvFile(join(root, "..", ".env")), ...loadEnvFile(join(root, ".dev.vars")) };
const cfg = (key) => process.env[key] ?? fileEnv[key];

const publicKey = cfg("LANGFUSE_PUBLIC_KEY");
const secretKey = cfg("LANGFUSE_SECRET_KEY");
const baseUrl = (cfg("LANGFUSE_BASE_URL") ?? "https://cloud.langfuse.com").replace(/\/+$/, "");

if (!publicKey || !secretKey) {
  console.error(
    "Missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY.\n" +
      "Set them in the environment, in ../.env, or in cloudflare/.dev.vars.\n" +
      "Japan-region projects also need LANGFUSE_BASE_URL=https://jp.cloud.langfuse.com",
  );
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`${publicKey}:${secretKey}`).toString("base64");

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Reads PROMPT_DEFAULTS out of src/prompts.ts.
 *
 * Imported as TypeScript through Node's type stripping so the registry has exactly one definition.
 * Parsing the file textually, or keeping a duplicate JSON copy beside it, would both reintroduce
 * the drift this whole mechanism exists to prevent.
 */
async function loadRegistry() {
  try {
    const mod = await import(join(root, "src", "prompts.ts"));
    return mod.PROMPT_DEFAULTS;
  } catch (err) {
    console.error(
      "Could not import src/prompts.ts.\n" +
        "This needs Node 22.6+ (type stripping). Try: node --experimental-strip-types scripts/sync-langfuse-prompts.mjs\n" +
        String(err?.message ?? err),
    );
    process.exit(1);
  }
}

/** The runtime's staleness rule, reimplemented here so the report matches what the app will do. */
function isCompatible(template, requires) {
  if (!requires?.length) return true;
  return requires.some((variable) => template.includes(`{{${variable}}}`));
}

async function fetchProduction(name) {
  const res = await fetch(
    `${baseUrl}/api/public/v2/prompts/${encodeURIComponent(name)}?label=production`,
    { headers: { authorization: auth } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch ${name}: HTTP ${res.status} ${await res.text()}`);
  return await res.json();
}

async function createVersion(name, text) {
  const res = await fetch(`${baseUrl}/api/public/v2/prompts`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ name, type: "text", prompt: text, labels: ["production"] }),
  });
  if (!res.ok) throw new Error(`create ${name}: HTTP ${res.status} ${await res.text()}`);
  return await res.json();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const registry = await loadRegistry();
const names = Object.keys(registry).filter((name) => !only || name === only).sort();

if (only && !names.length) {
  console.error(`No prompt named "${only}" in PROMPT_DEFAULTS. Known: ${Object.keys(registry).sort().join(", ")}`);
  process.exit(1);
}

console.log(`Langfuse: ${baseUrl}`);
console.log(apply ? "Mode: APPLY (will write)\n" : "Mode: dry run (no writes; pass --apply to sync)\n");

const planned = [];
let unchecked = 0;
for (const name of names) {
  const local = registry[name];
  let live = null;
  let error = null;
  try {
    live = await fetchProduction(name);
  } catch (err) {
    error = err;
  }

  if (error) {
    // Counted, not just logged: reporting "everything is current" after failing to check anything
    // would be worse than useless -- it would say the sync is done when nothing was verified.
    unchecked += 1;
    console.log(`  ?  ${name.padEnd(30)} could not be checked: ${error.message}`);
    continue;
  }

  const status = !live
    ? "missing"
    : !isCompatible(live.prompt ?? "", local.requires)
      ? "stale"
      : live.prompt === local.text
        ? "identical"
        : "differs";

  // "differs" means the live prompt still references the required variables, so the runtime is
  // using it happily -- someone has edited it in Langfuse. Not overwritten by default: that edit
  // is probably deliberate, and silently clobbering it is exactly the wrong behavior for a sync
  // tool. --all opts into replacing it.
  const needsPush = status === "missing" || status === "stale" || (all && status !== "identical");
  const label = { missing: "NEW ", stale: "STALE", identical: "ok  ", differs: "edited" }[status];
  console.log(
    `  ${needsPush ? "→" : " "} ${label.padEnd(6)} ${name.padEnd(30)}` +
      (live ? `v${live.version}` : "not in Langfuse") +
      `  requires: ${local.requires.join(", ")}`,
  );
  if (needsPush) planned.push({ name, text: local.text, status });
}

if (unchecked) {
  console.error(
    `\n${unchecked} of ${names.length} prompt(s) could not be checked against Langfuse.\n` +
      "Verify LANGFUSE_BASE_URL and the API keys, then re-run. Nothing was synced.",
  );
  process.exit(1);
}

if (!planned.length) {
  console.log("\nEverything the repository defines is already current in Langfuse. Nothing to do.");
  if (!all) console.log("(Prompts marked 'edited' were changed in Langfuse and are kept. Use --all to overwrite them.)");
  process.exit(0);
}

console.log(`\n${planned.length} prompt(s) need syncing: ${planned.map((p) => p.name).join(", ")}`);

if (!apply) {
  console.log("Dry run — nothing was written. Re-run with --apply to push these.");
  process.exit(0);
}

let failed = 0;
for (const { name, text } of planned) {
  try {
    const created = await createVersion(name, text);
    console.log(`  pushed ${name} -> v${created.version} (production)`);
  } catch (err) {
    failed += 1;
    console.error(`  FAILED ${name}: ${err.message}`);
  }
}

console.log(failed ? `\nDone with ${failed} failure(s).` : "\nDone. All pushed versions carry the production label.");
process.exit(failed ? 1 : 0);
