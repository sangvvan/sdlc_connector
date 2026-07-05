import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseReport } from '../src/collect/parse.js';
import { buildBugFile } from '../src/writeback/bugmap.js';
import { buildBacklogAppendix } from '../src/writeback/backlog.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/sample-report.json', import.meta.url));
const run = parseReport(FIXTURE);
const failure = run.failures.find((f) => f.scenarioId === 'NF-SEC-001')!;

describe('buildBugFile', () => {
  const bug = buildBugFile(failure, 7, run.runId);

  it('names and numbers the file BUG-{n}.md, zero-padded', () => {
    expect(bug.fileName).toBe('BUG-007.md');
    expect(bug.content).toContain('# BUG-007: Validate email input against SQL injection payload');
  });

  it('embeds the machine-readable source key for idempotency', () => {
    expect(bug.content).toContain(
      '<!-- ai-test-source: NF-SEC-001|http://localhost:3000/auth/login|' +
        'Validate email input against SQL injection payload -->',
    );
  });

  it('follows the minimal System A bug structure', () => {
    expect(bug.content).toContain('- **Severity**: high');
    expect(bug.content).toContain('- **Priority**: P1');
    expect(bug.content).toContain('- **Status**: open');
    expect(bug.content).toContain(`ai-test run \`${run.runId}\``);
    expect(bug.content).toContain('## Steps to reproduce');
    expect(bug.content).toContain('## Expected');
    expect(bug.content).toContain('Invalid credentials');
    expect(bug.content).toContain('## Actual');
    expect(bug.content).toContain('timeout');
    expect(bug.content).toContain('## Evidence');
  });

  it('numbers steps from the scenario', () => {
    expect(bug.content).toMatch(/1\. Open the login page/);
  });
});

describe('buildBacklogAppendix', () => {
  const bugs = [buildBugFile(failure, 7, run.runId)];
  const appendix = buildBacklogAppendix(bugs, run.runId);

  it('marks the block as machine-appended with the run id', () => {
    expect(appendix).toContain(`ai-test run ${run.runId}`);
    expect(appendix).toContain('appended by sdlc-connector');
  });

  it('lists one unchecked candidate per bug referencing the BUG file', () => {
    expect(appendix).toContain('- [ ] Fix BUG-007:');
    expect(appendix).toContain('`NF-SEC-001`');
  });

  it('starts with a newline so appending never corrupts the previous line', () => {
    expect(appendix.startsWith('\n')).toBe(true);
  });
});
