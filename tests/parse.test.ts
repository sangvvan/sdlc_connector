import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseReport } from '../src/collect/parse.js';

// Real report captured from System B — the external contract (§7).
const FIXTURE = fileURLToPath(new URL('../fixtures/sample-report.json', import.meta.url));

describe('parseReport (against real captured report)', () => {
  const run = parseReport(FIXTURE);

  it('reads run metadata', () => {
    expect(run.runId).toBe('R-20260530-143223-bbc6');
    expect(run.startedAt).toBe('2026-05-30T14:32:23.879Z');
  });

  it('reads totals from the report', () => {
    expect(run.totals).toEqual({ total: 44, passed: 19, failed: 25, skipped: 0 });
  });

  it('keys failures on validation.status, not result.status', () => {
    // In the real report only 9 scenarios have result.status=failed, but
    // totals.failed=25 matches validation.status — validation is truth.
    expect(run.failures).toHaveLength(25);
  });

  it('extracts per-failure details', () => {
    const f = run.failures.find((x) => x.scenarioId === 'NF-SEC-001');
    expect(f).toBeDefined();
    expect(f!.title).toBe('Validate email input against SQL injection payload');
    expect(f!.type).toBe('security');
    expect(f!.priority).toBe('P1');
    expect(f!.pageUrl).toBe('http://localhost:3000/auth/login');
    expect(f!.failureReason).toBe('timeout');
    expect(f!.severity).toBe('high');
    expect(f!.steps.length).toBeGreaterThan(0);
    expect(f!.expected).toBe('Invalid credentials');
    expect(f!.evidence.some((e) => e.includes('trace.zip'))).toBe(true);
  });

  it('parses role from the report app field', () => {
    expect(run.failures[0]!.role).toBe('admin');
  });

  it('disambiguates duplicate scenario ids by pageUrl in sourceKey', () => {
    const dups = run.failures.filter((f) => f.scenarioId === 'NF-USAB-001');
    expect(dups.length).toBe(2);
    const keys = new Set(dups.map((f) => f.sourceKey));
    expect(keys.size).toBe(2);
  });

  it('disambiguates same id+page with different titles (real EP-001 case)', () => {
    const dups = run.failures.filter(
      (f) => f.scenarioId === 'EP-001' && f.pageUrl === 'http://localhost:3000/',
    );
    expect(dups.length).toBe(2);
    expect(new Set(dups.map((f) => f.sourceKey)).size).toBe(2);
  });

  it('all failure sourceKeys are unique within the report', () => {
    const keys = run.failures.map((f) => f.sourceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('throws a readable error on non-JSON input', () => {
    expect(() => parseReport(fileURLToPath(new URL('./parse.test.ts', import.meta.url)))).toThrow(
      /not valid JSON/,
    );
  });
});
