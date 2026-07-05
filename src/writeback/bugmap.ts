import type { Failure } from '../collect/model.js';

export interface ProposedBug {
  number: number;
  fileName: string;
  content: string;
  failure: Failure;
}

/**
 * Map a System B failure to a BUG-{n}.md in System A's docs format (F6).
 *
 * System A's template had no existing BUG-*.md examples at capture time,
 * so this uses the minimal structure the PROBLEM_STATEMENT prescribes for
 * that case (§7): title, severity, steps, expected/actual, source line.
 *
 * The HTML comment `ai-test-source` line is the machine-readable
 * idempotency key (scenarioId|pageUrl) scanned by numbering.ts.
 */
export function buildBugFile(failure: Failure, bugNumber: number, runId: string): ProposedBug {
  const today = new Date().toISOString().slice(0, 10);
  const steps =
    failure.steps.length > 0
      ? failure.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '_No step details in report — see evidence._';
  const evidence =
    failure.evidence.length > 0
      ? failure.evidence.map((e) => `- \`${e}\` (System B repo)`).join('\n')
      : '_None recorded._';

  const content = `# BUG-${String(bugNumber).padStart(3, '0')}: ${failure.title}

<!-- ai-test-source: ${failure.sourceKey} -->

- **Severity**: ${failure.severity}
- **Priority**: ${failure.priority}
- **Status**: open
- **Reported**: ${today}
- **Source**: ai-test run \`${runId}\`, scenario \`${failure.scenarioId}\` (${failure.type})
- **Role**: ${failure.role || 'n/a'}
- **Page**: ${failure.pageUrl || 'n/a'}

## Steps to reproduce

${steps}

## Expected

${failure.expected || '_Not specified in scenario._'}

## Actual

${failure.failureReason}

## Evidence

${evidence}
`;

  return {
    number: bugNumber,
    fileName: `BUG-${String(bugNumber).padStart(3, '0')}.md`,
    content,
    failure,
  };
}
