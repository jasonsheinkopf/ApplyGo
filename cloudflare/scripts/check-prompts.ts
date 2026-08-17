#!/usr/bin/env node
// Validates src/prompts.ts's bundled prompt defaults against the contract getManagedPrompt (see
// src/langfuse.ts) assumes they satisfy, so a typo can't silently defeat the safety net described
// in that file's header comment:
//
// - Every variable named in a `requires` entry must actually appear in that prompt's `text` as
//   `{{variable}}`. If it doesn't, `isPromptCompatible` would judge the bundled default itself
//   incompatible with its own contract -- the exact "stale prompt" failure this mechanism exists
//   to catch, except now unfixable by promoting a new Langfuse version.
// - Every prompt must compile cleanly (compilePrompt) once every `{{variable}}` it references is
//   supplied, catching malformed placeholders (stray braces, non-alphabetic names) before they
//   reach a model.

import { compilePrompt } from "../src/langfuse.ts";
import { PROMPT_DEFAULTS } from "../src/prompts.ts";

const errors: string[] = [];

for (const [name, def] of Object.entries(PROMPT_DEFAULTS)) {
  const referenced = new Set(
    Array.from(def.text.matchAll(/{{\s*([A-Za-z_]+)\s*}}/g), (match) => match[1]),
  );

  for (const required of def.requires) {
    if (!referenced.has(required)) {
      errors.push(`${name}: "requires" lists "${required}" but the prompt text never references {{${required}}}`);
    }
  }

  try {
    const variables = Object.fromEntries([...referenced].map((v) => [v, `<${v}>`]));
    compilePrompt(def.text, variables);
  } catch (err) {
    errors.push(`${name}: failed to compile -- ${(err as Error).message}`);
  }
}

if (errors.length) {
  console.error(`prompts:check failed (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`prompts:check passed (${Object.keys(PROMPT_DEFAULTS).length} bundled prompts checked).`);
