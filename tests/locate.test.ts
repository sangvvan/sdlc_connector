import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorConfig } from '../src/config.js';
import { locateNewReports, locateNewestReport, resolveReportsDir } from '../src/collect/locate.js';

let repoB: string;

function configFor(repoPath: string): ConnectorConfig {
  return {
    systemA: { repoPath: '/unused', bugsDir: 'docs/bugs', backlogFile: 'docs/sprints/backlog.md' },
    systemB: { repoPath, inputsDir: 'inputs/projects', reportsDir: 'reports' },
    roles: [{ name: 'admin' }],
    crawl: {},
    generation: {},
    run: {},
    summaryDir: 'runs',
  };
}

beforeEach(() => {
  repoB = mkdtempSync(join(tmpdir(), 'system-b-'));
});

afterEach(() => {
  rmSync(repoB, { recursive: true, force: true });
});

describe('resolveReportsDir', () => {
  it("prefers System B's own configs/framework.config.yaml", () => {
    mkdirSync(join(repoB, 'configs'), { recursive: true });
    writeFileSync(join(repoB, 'configs', 'framework.config.yaml'), 'reportsDir: "output/reports"');
    expect(resolveReportsDir(configFor(repoB))).toBe(join(repoB, 'output/reports'));
  });

  it('falls back to connector config when System B has no framework config', () => {
    expect(resolveReportsDir(configFor(repoB))).toBe(join(repoB, 'reports'));
  });
});

describe('locateNewReports', () => {
  it('finds per-role run reports under reports/json/ (real System B layout)', () => {
    const jsonDir = join(repoB, 'reports', 'json');
    mkdirSync(jsonDir, { recursive: true });
    writeFileSync(join(jsonDir, 'R-admin.json'), '{}');
    writeFileSync(join(jsonDir, 'R-user.json'), '{}');
    // subdirs like evidence/ and workflows/ must be ignored
    mkdirSync(join(repoB, 'reports', 'evidence'), { recursive: true });
    writeFileSync(join(repoB, 'reports', 'evidence', 'not-a-report.json'), '{}');

    const found = locateNewReports(configFor(repoB));
    expect(found).toHaveLength(2);
    expect(found.every((p) => p.includes(join('reports', 'json')))).toBe(true);
  });

  it('also picks up top-level reports as a fallback', () => {
    mkdirSync(join(repoB, 'reports'), { recursive: true });
    writeFileSync(join(repoB, 'reports', 'R-manual.json'), '{}');
    expect(locateNewReports(configFor(repoB))).toHaveLength(1);
  });

  it('ignores reports older than `since`', () => {
    const jsonDir = join(repoB, 'reports', 'json');
    mkdirSync(jsonDir, { recursive: true });
    writeFileSync(join(jsonDir, 'R-old.json'), '{}');
    const future = new Date(Date.now() + 60_000);
    expect(locateNewReports(configFor(repoB), future)).toHaveLength(0);
  });

  it('returns [] when the reports dir does not exist', () => {
    expect(locateNewReports(configFor(repoB))).toEqual([]);
    expect(locateNewestReport(configFor(repoB))).toBeUndefined();
  });
});
