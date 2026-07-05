import { appendFileSync, existsSync } from 'node:fs';
import type { ProposedBug } from './bugmap.js';

/**
 * Build the backlog candidate lines for approved bugs (F8).
 * One block per connector run, clearly marked as machine-appended so the
 * next `/planning` in System A can triage them.
 */
export function buildBacklogAppendix(bugs: ProposedBug[], runLabel: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = bugs.map(
    (b) =>
      `- [ ] Fix ${b.fileName.replace('.md', '')}: ${b.failure.title} ` +
      `(${b.failure.priority}, ${b.failure.severity}) — from ai-test scenario \`${b.failure.scenarioId}\``,
  );
  return `
<!-- appended by sdlc-connector on ${today}, ai-test run ${runLabel} -->
### Candidates from AI system test (${runLabel})

${lines.join('\n')}
`;
}

/**
 * Append candidates to docs/sprints/backlog.md — STRICTLY append-only
 * (critical note 4): existing content is never read back, rewritten, or
 * reordered. Creates the file with a header if System A doesn't have one yet.
 */
export function appendToBacklog(backlogFileAbs: string, appendix: string): void {
  if (!existsSync(backlogFileAbs)) {
    appendFileSync(backlogFileAbs, `# Backlog\n${appendix}`, 'utf8');
    return;
  }
  appendFileSync(backlogFileAbs, appendix, 'utf8');
}
