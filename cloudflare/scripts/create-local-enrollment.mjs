#!/usr/bin/env node
// Creates a one-time device enrollment code against the LOCAL dev server (`npm run dev`), so you
// can log into http://localhost:8787 without touching the production database. Unlike
// create-enrollment.mjs (production, no secret needed via `wrangler d1 execute`), this goes
// through the actual POST /admin/enrollments endpoint, gated by SETUP_SECRET -- so it needs the
// dev server already running and a SETUP_SECRET line in cloudflare/.dev.vars (gitignored, local
// only; any value works, it's never checked against anything but itself).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const label = process.argv[2] ?? "";
const minutes = Math.min(Math.max(Number(process.argv[3] ?? 15), 1), 60);
const port = process.env.PORT || 8787;

const devVarsPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars");

let setupSecret;
try {
  const match = readFileSync(devVarsPath, "utf8").match(/^SETUP_SECRET=(.*)$/m);
  setupSecret = match?.[1]?.trim();
} catch {
  // Falls through to the same "missing" message as an empty file.
}

if (!setupSecret) {
  console.error(`\nNo SETUP_SECRET found in ${devVarsPath}.`);
  console.error("Add one line to that file (create it if it doesn't exist):");
  console.error("  SETUP_SECRET=anything-you-pick");
  console.error("It's gitignored and local-only -- restart `npm run dev` after adding it.");
  process.exit(1);
}

let res;
try {
  res = await fetch(`http://localhost:${port}/admin/enrollments`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-applygo-setup-secret": setupSecret },
    body: JSON.stringify({ label, minutes }),
  });
} catch (err) {
  console.error(`\nCouldn't reach the local dev server on port ${port}. Is \`npm run dev\` running?`);
  console.error(err.message);
  process.exit(1);
}

if (!res.ok) {
  console.error(`\nRequest failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const data = await res.json();
console.log(`\nLocal enrollment code (valid ${minutes} minutes): ${data.enrollment_code}`);
console.log(`Enter it at http://localhost:${port}/enroll`);
