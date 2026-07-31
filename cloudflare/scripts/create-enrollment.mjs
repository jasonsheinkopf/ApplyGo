#!/usr/bin/env node
// Creates a one-time device enrollment code directly in the production D1
// database via `wrangler d1 execute`, using whatever Cloudflare account the
// caller is already logged into (`npx wrangler login`). No SETUP_SECRET or
// deployed-Worker network access required.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const label = process.argv[2] ?? "";
const minutes = Math.min(Math.max(Number(process.argv[3] ?? 15), 1), 60);

const code = randomBytes(18).toString("base64url");
const codeHash = createHash("sha256").update(code).digest("hex");
const id = randomUUID();
const escapedLabel = label.replace(/'/g, "''");

const sql = `INSERT INTO enrollment_codes (id, code_hash, label, expires_at) VALUES ('${id}', '${codeHash}', '${escapedLabel}', datetime('now', '+${minutes} minutes'));`;

const result = spawnSync(
  "npx",
  ["wrangler", "d1", "execute", "applygo-prod-db", "--remote", "--env", "production", "--command", sql],
  { stdio: "inherit" },
);

if (result.status !== 0) {
  console.error("\nFailed to create enrollment code.");
  process.exit(result.status ?? 1);
}

console.log(`\nEnrollment code (valid ${minutes} minutes): ${code}`);
console.log("Enter it at https://applygo-prod.jasonsheinkopf.workers.dev/enroll");
