import type { Failure } from '../collect/model.js';

export interface ProposedBug {
  number: number;
  fileName: string;
  content: string;
  failure: Failure;
}

function yamlQuote(s: string): string {
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * Map a System B failure to a BUG-{n}.md in System A's docs format (F6),
 * modeled on the real docs/bugs/BUG-001.md in the template repo: YAML
 * frontmatter (id, title, severity, status, created_at, traces_to, owner)
 * followed by `# BUG-{n} - Title` and Summary/Evidence-style sections.
 *
 * The HTML comment `ai-test-source` line is the machine-readable
 * idempotency key (scenarioId|pageUrl|title) scanned by numbering.ts.
 */
export function buildBugFile(failure: Failure, bugNumber: number): ProposedBug {
  const today = new Date().toISOString().slice(0, 10);
  const id = `BUG-${String(bugNumber).padStart(3, '0')}`;
  const steps =
    failure.steps.length > 0
      ? failure.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '_No step details in report — see evidence._';
  const evidence =
    failure.evidence.length > 0
      ? failure.evidence.map((e) => `- \`${e}\` (System B repo)`).join('\n')
      : '_None recorded._';

  const content = `---
id: ${id}
title: ${yamlQuote(failure.title)}
severity: ${failure.severity}
status: open
created_at: ${today}
traces_to: []
owner: QA
---

<!-- ai-test-source: ${failure.sourceKey} -->

# ${id} - ${failure.title}

## Summary

AI system test scenario \`${failure.scenarioId}\` (${failure.type}, ${failure.priority}) failed for role \`${failure.role || 'n/a'}\` on ${failure.pageUrl || 'n/a'} during ai-test run \`${failure.runId}\`.

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
    fileName: `${id}.md`,
    content,
    failure,
  };
}
