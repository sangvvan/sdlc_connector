import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
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
 * Sanity tripwire for the build stage: System A's run.sh runs with
 * `set +e` and prints "✓ complete" even when its own sub-scripts crash,
 * so a broken template can "succeed" while producing nothing. The
 * template also SHIPS example REQ-*.md files, so existence proves
 * nothing — instead snapshot name+mtime before the build and require
 * that at least one REQ file was created or rewritten by it.
 */
export function snapshotRequirements(repoAPath: string): Record<string, number> {
  const snapshot: Record<string, number> = {};
  const dir = join(repoAPath, 'docs', 'requirements');
  try {
    for (const f of readdirSync(dir)) {
      if (!/^REQ-.+\.md$/.test(f)) continue;
      snapshot[f] = statSync(join(dir, f)).mtimeMs;
    }
  } catch {
    // no requirements dir yet — empty snapshot
  }
  return snapshot;
}

export function requirementsChanged(
  repoAPath: string,
  before: Record<string, number>,
): boolean {
  const after = snapshotRequirements(repoAPath);
  return Object.entries(after).some(([name, mtime]) => before[name] !== mtime);
}

/** First free localhost port in [start, start+100). */
export async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 100; port++) {
    const free = await new Promise<boolean>((resolvePromise) => {
      const srv = createServer();
      srv.once('error', () => resolvePromise(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolvePromise(true)));
    });
    if (free) return port;
  }
  throw new Error(`Không tìm được port trống trong khoảng ${start}..${start + 99}`);
}

const PG_BIND = '127.0.0.1:5433:5432';
const PG_BIND_PARAM = '127.0.0.1:${POSTGRES_HOST_PORT:-5433}:5432';

/**
 * Make the postgres HOST port overridable in the CLONED project's
 * docker-compose.yml (the template hardcodes 5433, so two projects can
 * never run side by side). This edits the project's own repo — an
 * artifact the connector already writes into — never the template.
 * Idempotent; returns whether the port is parametrized afterwards.
 */
export function parametrizePostgresPort(repoAPath: string): boolean {
  const file = join(repoAPath, 'docker-compose.yml');
  if (!existsSync(file)) return false;
  const src = readFileSync(file, 'utf8');
  if (src.includes('POSTGRES_HOST_PORT')) return true;
  if (!src.includes(PG_BIND)) return false;
  writeFileSync(file, src.replace(PG_BIND, PG_BIND_PARAM), 'utf8');
  return true;
}

export interface LocalDeployPrep {
  envCreated: boolean;
  appPort: string;
  /** Host port assigned to postgres, undefined when compose isn't parametrizable. */
  pgPort?: string;
}

/**
 * Per-project port isolation for LOCAL deploys, so several factory
 * projects can run side by side:
 *
 * - .env generated from .env.example when missing (ensureDevEnv)
 * - LOCAL_PORT / BASE_URL derived from the app URL the user chose
 *   (compose maps "${LOCAL_PORT:-3000}:3000")
 * - postgres host port parametrized in the project's compose file and a
 *   free port allocated once, persisted as POSTGRES_HOST_PORT in .env
 *   (host-side DATABASE_URL kept in sync for migrations)
 *
 * Existing values are respected: variables already present in .env are
 * never overwritten, so re-deploys keep their ports.
 */
export async function prepareLocalDeploy(
  repoAPath: string,
  appUrl: string,
): Promise<LocalDeployPrep> {
  const envCreated = ensureDevEnv(repoAPath) === 'created';
  const envPath = join(repoAPath, '.env');
  if (!existsSync(envPath)) {
    return { envCreated, appPort: new URL(appUrl).port || '3000' };
  }
  let env = readFileSync(envPath, 'utf8');
  const has = (key: string): boolean => new RegExp(`^${key}=`, 'm').test(env);
  const appPort = new URL(appUrl).port || '3000';

  if (envCreated) {
    env = env.replace(/^BASE_URL=.*$/m, `BASE_URL=${appUrl}`);
  }
  if (!has('LOCAL_PORT')) {
    env += `\n# per-project ports (sdlc-connector)\nLOCAL_PORT=${appPort}\n`;
  }

  let pgPort: string | undefined;
  if (parametrizePostgresPort(repoAPath)) {
    const existing = /^POSTGRES_HOST_PORT=(\d+)/m.exec(env);
    if (existing) {
      pgPort = existing[1]!;
    } else {
      pgPort = String(await findFreePort(5433));
      env += `POSTGRES_HOST_PORT=${pgPort}\n`;
      // host-side DATABASE_URL (migrations from the host) must follow
      env = env.replaceAll('localhost:5433', `localhost:${pgPort}`);
    }
  }

  writeFileSync(envPath, env, 'utf8');
  return { envCreated, appPort, pgPort };
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
