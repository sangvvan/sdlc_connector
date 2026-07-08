import {
  appendFileSync,
  createWriteStream,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import type { ConnectorConfig } from '../config.js';
import { parseGitHubRepo, projectPaths, type NewProjectRequest, type ProjectPaths } from './bootstrap.js';

/**
 * Job runner for `connect web`. One job = one project kickoff:
 *
 *   1. clone   — git clone the System A template into the workspace
 *   2. install — npm install in the new project repo
 *   3. pipeline — `connect pipeline --yes` with the generated config
 *      (build → deploy → test → write-back, reusing the CLI unchanged)
 *
 * All output is appended to {workspace}/{name}.log; state transitions
 * are persisted to {name}.state.json so the UI survives server restarts.
 */

export type JobStatus = 'running' | 'succeeded' | 'failed';

export interface JobState {
  name: string;
  status: JobStatus;
  step: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  request: NewProjectRequest;
  /** Filled from the newest run summary once the pipeline finishes. */
  result?: {
    summaryPath: string;
    totals?: unknown;
    bugsWritten?: string[];
    runIds?: string[];
    /** Set when a gitRemote was requested: did the final push succeed? */
    pushed?: boolean;
  };
}

function saveState(paths: ProjectPaths, state: JobState): void {
  writeFileSync(paths.stateFile, JSON.stringify(state, null, 2), 'utf8');
}

export function loadState(config: ConnectorConfig, name: string): JobState | undefined {
  const paths = projectPaths(config, name);
  try {
    return JSON.parse(readFileSync(paths.stateFile, 'utf8')) as JobState;
  } catch {
    return undefined;
  }
}

export function listProjects(config: ConnectorConfig): JobState[] {
  const ws = projectPaths(config, 'x').stateFile.replace(/[/\\]x\.state\.json$/, '');
  let entries: string[];
  try {
    entries = readdirSync(ws);
  } catch {
    return [];
  }
  const states: JobState[] = [];
  for (const e of entries) {
    const m = /^(.+)\.state\.json$/.exec(e);
    if (!m) continue;
    const s = loadState(config, m[1]!);
    if (s) states.push(s);
  }
  return states.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function readLog(config: ConnectorConfig, name: string): string {
  try {
    return readFileSync(projectPaths(config, name).logFile, 'utf8');
  } catch {
    return '';
  }
}

function newestSummary(summaryDir: string): string | undefined {
  try {
    const files = readdirSync(summaryDir)
      .filter((f) => f.startsWith('summary-') && f.endsWith('.json'))
      .sort();
    const last = files[files.length - 1];
    return last ? join(summaryDir, last) : undefined;
  } catch {
    return undefined;
  }
}

function note(paths: ProjectPaths, msg: string): void {
  appendFileSync(paths.logFile, `${msg}\n`, 'utf8');
}

/** Run a step and return its exit code (logged, never throws). */
async function runStepSoft(
  paths: ProjectPaths,
  state: JobState,
  step: string,
  bin: string,
  args: string[],
  cwd: string,
): Promise<number> {
  state.step = step;
  saveState(paths, state);
  const log = createWriteStream(paths.logFile, { flags: 'a' });
  log.write(`\n──── ${step}: ${bin} ${args.join(' ')} (cwd: ${cwd}) ────\n`);
  const child = execa(bin, args, { cwd, reject: false, all: true });
  child.all?.pipe(log, { end: false });
  const result = await child;
  log.end();
  return result.exitCode ?? -1;
}

async function runStep(
  paths: ProjectPaths,
  state: JobState,
  step: string,
  bin: string,
  args: string[],
  cwd: string,
): Promise<void> {
  const exitCode = await runStepSoft(paths, state, step, bin, args, cwd);
  if (exitCode !== 0) {
    throw new Error(`${step} failed (exit ${exitCode}) — see log`);
  }
}

const GIT_ID = ['-c', 'user.name=sdlc-connector', '-c', 'user.email=connector@localhost'];

/**
 * Detach the fresh clone from the template's history and point it at the
 * user's GitHub repo — using the existing repo when reachable, creating
 * it (private) via `gh repo create` when not. Linking problems are
 * logged as warnings, never fatal: the built project on disk is the
 * primary deliverable, publishing it is best-effort.
 */
async function linkGitRemote(
  paths: ProjectPaths,
  state: JobState,
  remote: string,
  freshClone: boolean,
): Promise<void> {
  if (freshClone) {
    rmSync(join(paths.dir, '.git'), { recursive: true, force: true });
    await runStep(paths, state, 'git-init', 'git', ['init', '-b', 'main'], paths.dir);
    await runStep(paths, state, 'git-init', 'git', ['add', '-A'], paths.dir);
    await runStep(
      paths,
      state,
      'git-init',
      'git',
      [...GIT_ID, 'commit', '-m', `Initial commit from SDLC template (${state.name})`],
      paths.dir,
    );
  }

  const reachable =
    (await runStepSoft(paths, state, 'git-remote', 'git', ['ls-remote', remote], paths.dir)) === 0;
  if (!reachable) {
    const gh = parseGitHubRepo(remote);
    if (!gh) {
      note(paths, `⚠ Không parse được ${remote} — bỏ qua việc tạo repo`);
      return;
    }
    note(paths, `Repo chưa tồn tại — tạo mới (private): ${gh.owner}/${gh.repo}`);
    const created = await runStepSoft(
      paths,
      state,
      'git-remote',
      'gh',
      ['repo', 'create', `${gh.owner}/${gh.repo}`, '--private'],
      paths.dir,
    );
    if (created !== 0) {
      note(paths, '⚠ `gh repo create` thất bại (gh chưa cài/chưa login?) — project vẫn build tiếp, chỉ không push được');
      return;
    }
  }
  await runStepSoft(paths, state, 'git-remote', 'git', ['remote', 'remove', 'origin'], paths.dir);
  await runStep(paths, state, 'git-remote', 'git', ['remote', 'add', 'origin', remote], paths.dir);
}

/** Commit everything the pipeline produced and push (best-effort). */
async function publishToRemote(paths: ProjectPaths, state: JobState): Promise<boolean> {
  await runStepSoft(paths, state, 'publish', 'git', ['add', '-A'], paths.dir);
  await runStepSoft(
    paths,
    state,
    'publish',
    'git',
    [...GIT_ID, 'commit', '-m', `AI build via sdlc-connector pipeline (${state.name})`],
    paths.dir,
  ); // exit 1 when nothing to commit — fine
  const pushed =
    (await runStepSoft(paths, state, 'publish', 'git', ['push', '-u', 'origin', 'main'], paths.dir)) === 0;
  if (!pushed) note(paths, '⚠ push thất bại — kiểm tra quyền/`gh auth status`, rồi push tay từ thư mục project');
  return pushed;
}

/**
 * Start a kickoff job in the background. Returns immediately; progress
 * is observable via state + log polling. `connectorRoot` is the checkout
 * of this connector (where src/cli.ts lives).
 */
export function startJob(
  config: ConnectorConfig,
  req: NewProjectRequest,
  connectorRoot: string,
): JobState {
  const paths = projectPaths(config, req.name);
  const state: JobState = {
    name: req.name,
    status: 'running',
    step: 'queued',
    startedAt: new Date().toISOString(),
    request: req,
  };
  writeFileSync(paths.logFile, `Project kickoff: ${req.name} — ${state.startedAt}\n`, 'utf8');
  saveState(paths, state);

  void (async () => {
    try {
      let freshClone = false;
      if (!existsSync(paths.dir)) {
        const template = config.web.templateRepo;
        if (!template) {
          throw new Error('web.templateRepo chưa cấu hình trong connector.config.yaml');
        }
        await runStep(paths, state, 'clone', 'git', ['clone', '--depth', '1', template, paths.dir], connectorRoot);
        freshClone = true;
      }
      if (req.gitRemote?.trim()) {
        await linkGitRemote(paths, state, req.gitRemote.trim(), freshClone);
      }
      if (!existsSync(join(paths.dir, 'node_modules'))) {
        await runStep(paths, state, 'install', 'npm', ['install'], paths.dir);
      }
      const flags = [
        ...(req.skipBuild ? ['--skip-build'] : []),
        ...(req.skipDeploy ? ['--skip-deploy'] : []),
      ];
      await runStep(
        paths,
        state,
        'pipeline',
        'npx',
        ['tsx', 'src/cli.ts', '--config', paths.configFile, 'pipeline', '--yes', ...flags],
        connectorRoot,
      );

      let pushed: boolean | undefined;
      if (req.gitRemote?.trim()) {
        pushed = await publishToRemote(paths, state);
      }

      const summaryPath = newestSummary(paths.summaryDir);
      if (summaryPath) {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>;
        state.result = {
          summaryPath,
          totals: summary.totals,
          bugsWritten: summary.bugsWritten as string[] | undefined,
          runIds: summary.runIds as string[] | undefined,
          ...(pushed !== undefined ? { pushed } : {}),
        };
      }
      state.status = 'succeeded';
      state.step = 'done';
    } catch (e) {
      state.status = 'failed';
      state.error = (e as Error).message;
    } finally {
      state.finishedAt = new Date().toISOString();
      saveState(paths, state);
    }
  })();

  return state;
}
