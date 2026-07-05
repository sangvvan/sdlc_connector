import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { makeSourceKey, type Failure, type RunResult } from './model.js';

/**
 * Defensive schema for System B's report JSON, written against the real
 * captured report `fixtures/sample-report.json` (constraint §7: the schema
 * is an external contract — read a real file, don't invent fields).
 *
 * Almost everything is optional with fallbacks; anything missing that we
 * care about becomes an explicit warning on the RunResult, never a crash.
 */
const stepSchema = z
  .object({
    description: z.string().optional(),
  })
  .passthrough();

const scenarioEntrySchema = z
  .object({
    scenario: z
      .object({
        id: z.string().optional(),
        title: z.string().optional(),
        type: z.string().optional(),
        priority: z.string().optional(),
        pageUrl: z.string().optional(),
        steps: z.array(stepSchema).optional(),
        expectedResult: z.object({ text: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    result: z
      .object({
        status: z.string().optional(),
        screenshotPath: z.string().optional(),
        tracePath: z.string().optional(),
      })
      .passthrough()
      .optional(),
    validation: z
      .object({
        status: z.string().optional(),
        failureReason: z.string().optional(),
        suggestedDefect: z
          .object({
            summary: z.string().optional(),
            severity: z.string().optional(),
            stepsToReproduce: z.array(z.string()).optional(),
            evidenceLinks: z.array(z.string()).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const reportSchema = z
  .object({
    runId: z.string().optional(),
    app: z.string().optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    totals: z
      .object({
        total: z.number().optional(),
        passed: z.number().optional(),
        failed: z.number().optional(),
        skipped: z.number().optional(),
      })
      .passthrough()
      .optional(),
    scenarios: z.array(scenarioEntrySchema).optional(),
  })
  .passthrough();

/** Map priority to a severity when suggestedDefect.severity is absent. */
function severityFromPriority(priority: string): string {
  switch (priority) {
    case 'P1':
      return 'high';
    case 'P2':
      return 'medium';
    default:
      return 'low';
  }
}

/** Extract role from the report's `app` field, e.g. "project:x role:admin". */
function roleFromApp(app: string | undefined): string {
  const m = /role:(\S+)/.exec(app ?? '');
  return m?.[1] ?? '';
}

/**
 * Parse a System B JSON report into the normalized RunResult (F5).
 *
 * Pass/fail is keyed on `validation.status`, NOT `result.status`: in the
 * captured report totals.failed=25 matches validation.status counts
 * (execution can pass while validation fails the expected-result check).
 */
export function parseReport(reportPath: string): RunResult {
  const raw = readFileSync(reportPath, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Report is not valid JSON: ${reportPath} (${(e as Error).message})`);
  }

  const parsed = reportSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Report shape unrecognized: ${reportPath}\n${parsed.error.message}`);
  }
  const report = parsed.data;
  const warnings: string[] = [];
  const role = roleFromApp(report.app);
  if (!role) warnings.push(`no role found in report "app" field (${report.app ?? 'absent'})`);

  const scenarios = report.scenarios ?? [];
  if (!report.scenarios) warnings.push('report has no "scenarios" array');

  const failures: Failure[] = [];
  for (const [i, entry] of scenarios.entries()) {
    const validationStatus = entry.validation?.status;
    if (!validationStatus) {
      warnings.push(`scenario[${i}] missing validation.status — skipped`);
      continue;
    }
    if (validationStatus !== 'failed') continue;

    const sc = entry.scenario ?? {};
    const val = entry.validation ?? {};
    const res = entry.result ?? {};
    const defect = val.suggestedDefect;

    const scenarioId = sc.id ?? `unknown-${i}`;
    if (!sc.id) warnings.push(`failed scenario[${i}] has no scenario.id`);
    const pageUrl = sc.pageUrl ?? '';
    if (!sc.pageUrl) warnings.push(`failed scenario ${scenarioId} has no pageUrl`);
    const priority = sc.priority ?? 'P3';
    const title = sc.title ?? defect?.summary ?? `Scenario ${scenarioId} failed`;

    const evidence = [
      ...(defect?.evidenceLinks ?? []),
      ...(res.screenshotPath ? [res.screenshotPath] : []),
      ...(res.tracePath ? [res.tracePath] : []),
    ];

    failures.push({
      scenarioId,
      title,
      type: sc.type ?? 'unknown',
      priority,
      pageUrl,
      role,
      failureReason: val.failureReason ?? defect?.summary ?? 'unspecified failure',
      severity: defect?.severity ?? severityFromPriority(priority),
      steps: (sc.steps ?? []).map((s, j) => s.description ?? `(step ${j})`),
      expected: sc.expectedResult?.text ?? '',
      evidence: [...new Set(evidence)],
      sourceKey: makeSourceKey(scenarioId, pageUrl, title),
    });
  }

  // Prefer the report's own totals; recompute from scenarios if absent.
  const t = report.totals;
  const failedByValidation = scenarios.filter((s) => s.validation?.status === 'failed').length;
  const passedByValidation = scenarios.filter((s) => s.validation?.status === 'passed').length;
  const totals = {
    total: t?.total ?? scenarios.length,
    passed: t?.passed ?? passedByValidation,
    failed: t?.failed ?? failedByValidation,
    skipped: t?.skipped ?? 0,
  };
  if (!t) warnings.push('report has no "totals" — recomputed from scenarios');
  else if (t.failed !== undefined && t.failed !== failedByValidation) {
    warnings.push(
      `totals.failed=${t.failed} but ${failedByValidation} scenarios have validation.status=failed`,
    );
  }

  return {
    runId: report.runId ?? 'unknown-run',
    startedAt: report.startedAt ?? '',
    finishedAt: report.finishedAt ?? '',
    totals,
    failures,
    warnings,
    reportPath,
  };
}
