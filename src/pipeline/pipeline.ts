import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { execa } from 'execa';

/**
 * `connect pipeline` stage helpers. The connector never re-implements
 * System A's phases — it drives System A's OWN scripts (run.sh /feature,
 * deploy.sh) as subprocesses, then hands off to the existing test chain.
 */

export interface RequirementTokens {
  /** Raw requirement text — avoid in commands for long documents. */
  requirement: string;
  /** Absolute path of the source requirement file. */
  requirementFile: string;
  /** Path of the doc written into System A's repo (relative to it). */
  requirementDoc: string;
}

/** Replace {requirement} / {requirementFile} / {requirementDoc} tokens. */
export function substituteTokens(command: string[], tokens: RequirementTokens): string[] {
  return command.map((part) =>
    part
      .replaceAll('{requirement}', tokens.requirement)
      .replaceAll('{requirementFile}', tokens.requirementFile)
      .replaceAll('{requirementDoc}', tokens.requirementDoc),
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
 * For LOCAL deploys only: a factory-cloned project has .env.example but
 * no .env, and System A's deploy.sh preflight hard-fails on missing
 * SESSION_SECRET / POSTGRES_PASSWORD. Generate a dev .env by replacing
 * every CHANGE_ME_* placeholder with a random secret — the same
 * placeholder gets the same value everywhere, so pairs like
 * POSTGRES_PASSWORD and the password inside DATABASE_URL stay in sync.
 * Never touches an existing .env, and never runs for cloud targets
 * (real secrets there are the user's call, not something to fabricate).
 */
export function ensureDevEnv(repoAPath: string): 'created' | 'exists' | 'no-template' {
  const envPath = join(repoAPath, '.env');
  if (existsSync(envPath)) return 'exists';
  const examplePath = join(repoAPath, '.env.example');
  if (!existsSync(examplePath)) return 'no-template';

  const example = readFileSync(examplePath, 'utf8');
  const secrets = new Map<string, string>();
  const env = example.replace(/CHANGE_ME\w*/g, (token) => {
    let v = secrets.get(token);
    if (!v) {
      v = randomBytes(24).toString('hex');
      secrets.set(token, v);
    }
    return v;
  });
  writeFileSync(envPath, env, { encoding: 'utf8', mode: 0o600 });
  return 'created';
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
