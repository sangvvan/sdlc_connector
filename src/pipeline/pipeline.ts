import { execa } from 'execa';

/**
 * `connect pipeline` stage helpers. The connector never re-implements
 * System A's phases — it drives System A's OWN scripts (run.sh /feature,
 * deploy.sh) as subprocesses, then hands off to the existing test chain.
 */

/** Replace {requirement} / {requirementFile} tokens in a configured command. */
export function substituteTokens(
  command: string[],
  requirement: string,
  requirementFileAbs: string,
): string[] {
  return command.map((part) =>
    part.replaceAll('{requirement}', requirement).replaceAll('{requirementFile}', requirementFileAbs),
  );
}

/**
 * Run one pipeline stage command inside a repo, streaming output live.
 * Throws on non-zero exit — a failed build/deploy stops the chain
 * (fail loud, per NFR).
 */
export async function runStageCommand(command: string[], cwd: string): Promise<void> {
  const [bin, ...args] = command;
  const result = await execa(bin!, args, { cwd, stdio: 'inherit', reject: false });
  if ((result.exitCode ?? -1) !== 0) {
    throw new Error(
      `Stage command failed (exit ${result.exitCode}): ${command.join(' ')} (cwd: ${cwd})`,
    );
  }
}

/**
 * Poll a URL until the app answers (any HTTP status < 500 counts as up —
 * a login redirect or 404 on / still proves the server is serving).
 * Throws after `timeoutSec`.
 */
export async function waitForUrl(
  url: string,
  timeoutSec: number,
  intervalMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `App at ${url} not healthy after ${timeoutSec}s (last: ${lastError}) — ` +
      `check the deploy stage output above.`,
  );
}
