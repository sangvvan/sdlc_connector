import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectorConfig } from '../config.js';

/**
 * Find the newest JSON report under System B's `reports/` (F4).
 *
 * Only top-level *.json files count — System B keeps evidence and test
 * plans in subdirectories (`reports/evidence/`, `reports/test-plans/`).
 * `since` restricts to files modified after the workflow started, so a
 * stale report from a previous run is never mistaken for this run's.
 */
export function locateNewestReport(config: ConnectorConfig, since?: Date): string | undefined {
  const dir = join(config.systemB.repoPath, config.systemB.reportsDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }

  let newest: { path: string; mtime: number } | undefined;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (since && st.mtimeMs < since.getTime()) continue;
    if (!newest || st.mtimeMs > newest.mtime) {
      newest = { path, mtime: st.mtimeMs };
    }
  }
  return newest?.path;
}
