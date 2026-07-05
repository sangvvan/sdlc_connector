import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ConnectorConfig } from '../config.js';

/**
 * Resolve System B's real reports dir: its own
 * `configs/framework.config.yaml` (`reportsDir`, default "reports") wins
 * over the connector config, so a relocated reports dir never breaks the
 * chain. Read-only — zero intrusion.
 */
export function resolveReportsDir(config: ConnectorConfig): string {
  const repo = config.systemB.repoPath;
  try {
    const raw = readFileSync(join(repo, 'configs', 'framework.config.yaml'), 'utf8');
    const parsed = parse(raw) as { reportsDir?: unknown } | null;
    if (parsed && typeof parsed.reportsDir === 'string' && parsed.reportsDir.length > 0) {
      return join(repo, parsed.reportsDir);
    }
  } catch {
    // fall through to connector config
  }
  return join(repo, config.systemB.reportsDir);
}

function jsonFilesIn(dir: string, since?: Date): { path: string; mtime: number }[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: { path: string; mtime: number }[] = [];
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
    files.push({ path, mtime: st.mtimeMs });
  }
  return files;
}

/**
 * Find run report JSONs under System B's reports dir (F4).
 *
 * The workflow writes one report per role to `{reportsDir}/json/{runId}.json`
 * (lib/reporter/json.ts), so a multi-role run yields several files — all of
 * them are returned, oldest first. The reports dir root is also scanned as
 * a fallback for manually placed reports. Subdirectories like `evidence/`,
 * `test-plans/`, `workflows/` are ignored.
 *
 * `since` restricts to files modified after the workflow started, so a
 * stale report from a previous run is never mistaken for this run's.
 */
export function locateNewReports(config: ConnectorConfig, since?: Date): string[] {
  const reportsDir = resolveReportsDir(config);
  const files = [...jsonFilesIn(join(reportsDir, 'json'), since), ...jsonFilesIn(reportsDir, since)];
  files.sort((a, b) => a.mtime - b.mtime);
  return files.map((f) => f.path);
}

/** Newest single report, for `collect-only` without an explicit --report. */
export function locateNewestReport(config: ConnectorConfig, since?: Date): string | undefined {
  const all = locateNewReports(config, since);
  return all[all.length - 1];
}
