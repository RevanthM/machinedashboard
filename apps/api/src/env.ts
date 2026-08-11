/**
 * Loads the repo-root .env into process.env as a side effect.
 *
 * Must be the FIRST import in any entry point. ES modules evaluate imports in
 * declaration order, so importing this before anything that reads config
 * guarantees the environment is populated first — `config.ts` snapshots
 * process.env at module-evaluation time, and a static import of it anywhere in
 * the graph would otherwise be hoisted ahead of an inline load call.
 *
 * Doing it here rather than via `node --env-file` keeps behaviour identical
 * however the process is launched: npm script, tsx directly, or dist build.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// src/env.ts -> apps/api -> apps -> repo root
for (const candidate of [
  join(here, '..', '..', '..', '.env'),
  join(here, '..', '..', '..', '..', '.env'),
]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}
