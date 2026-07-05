/**
 * Normalized result model (F5). Field mapping is coded against the REAL
 * captured report `fixtures/sample-report.json` — do not invent fields.
 */

export interface RunTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface Failure {
  /** System B scenario id, e.g. "NF-SEC-001". NOT unique within a report. */
  scenarioId: string;
  title: string;
  /** Scenario type, e.g. "security", "boundary". */
  type: string;
  /** P1 | P2 | P3 in the captured report. */
  priority: string;
  /** Page the scenario targeted. Disambiguates duplicate scenario ids. */
  pageUrl: string;
  /** Role from the report's `app` field ("project:x role:y"); '' if absent. */
  role: string;
  /** System B run id of the report this failure came from (one run per role). */
  runId: string;
  /** From validation.failureReason / suggestedDefect.summary. */
  failureReason: string;
  /** From validation.suggestedDefect.severity, fallback derived from priority. */
  severity: string;
  /** Scenario step descriptions, in order. */
  steps: string[];
  /** scenario.expectedResult.text, '' if absent. */
  expected: string;
  /** Evidence paths (screenshots, traces), relative to System B repo. */
  evidence: string[];
  /**
   * Idempotency key embedded into BUG files:
   * `${scenarioId}|${pageUrl}|${title}`. In the real captured report,
   * scenario ids repeat across pages AND the same id+page pair appears
   * with different AI-generated titles (e.g. EP-001 twice on `/`), so all
   * three parts are needed for a stable failure identity (F11 / AC-7).
   */
  sourceKey: string;
}

export interface RunResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  totals: RunTotals;
  failures: Failure[];
  /** Defensive-parsing warnings (missing/odd fields), surfaced not swallowed. */
  warnings: string[];
  /** Absolute path of the parsed report file. */
  reportPath: string;
}

export function makeSourceKey(scenarioId: string, pageUrl: string, title: string): string {
  // Keys live inside an HTML comment in the BUG file — keep them one line
  // and free of the comment terminator.
  const safeTitle = title.replace(/\s+/g, ' ').replaceAll('-->', '').trim();
  return `${scenarioId}|${pageUrl}|${safeTitle}`;
}
