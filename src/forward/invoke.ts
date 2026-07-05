import { relative } from 'node:path';
import { execa } from 'execa';
import type { ConnectorConfig } from '../config.js';

export interface InvokeResult {
  exitCode: number;
  command: string;
  startedAt: Date;
  finishedAt: Date;
}

/**
 * Run `npm run ai-test -- workflow --input <file>` inside System B's repo,
 * streaming its output live to our console (F3 — demo visibility).
 *
 * Exit-code semantics (PROBLEM_STATEMENT OQ-2): we do NOT decide
 * success/failure here. "Tests failed" is a successful connector run —
 * the caller checks whether a new report file appeared to distinguish
 * "ran with failures" from "could not run".
 */
export async function invokeSystemB(
  config: ConnectorConfig,
  inputFileAbs: string,
): Promise<InvokeResult> {
  const cwd = config.systemB.repoPath;
  const inputRel = relative(cwd, inputFileAbs);
  const args = ['run', 'ai-test', '--', 'workflow', '--input', inputRel];
  const startedAt = new Date();

  // stdio inherit: System B's own output scrolls in our terminal.
  // Report location comes from the filesystem, not stdout, so no capture.
  const result = await execa('npm', args, {
    cwd,
    stdio: 'inherit',
    reject: false,
  });

  return {
    exitCode: result.exitCode ?? -1,
    command: `npm ${args.join(' ')}`,
    startedAt,
    finishedAt: new Date(),
  };
}
