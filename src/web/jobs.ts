import { createWriteStream, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import type { ConnectorConfig } from '../config.js';
import { projectPaths, type NewProjectRequest, type ProjectPaths } from './bootstrap.js';

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

async function runStep(
  paths: ProjectPaths,
  state: JobState,
  step: string,
  bin: string,
  args: string[],
  cwd: string,
): Promise<void> {
  state.step = step;
  saveState(paths, state);
  const log = createWriteStream(paths.logFile, { flags: 'a' });
  log.write(`\n──── ${step}: ${bin} ${args.join(' ')} (cwd: ${cwd}) ────\n`);
  const child = execa(bin, args, { cwd, reject: false, all: true });
  child.all?.pipe(log, { end: false });
  const result = await child;
  log.end();
  if ((result.exitCode ?? -1) !== 0) {
    throw new Error(`${step} failed (exit ${result.exitCode}) — see log`);
  }
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
      if (!existsSync(paths.dir)) {
        const template = config.web.templateRepo;
        if (!template) {
          throw new Error('web.templateRepo chưa cấu hình trong connector.config.yaml');
        }
        await runStep(paths, state, 'clone', 'git', ['clone', '--depth', '1', template, paths.dir], connectorRoot);
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

      const summaryPath = newestSummary(paths.summaryDir);
      if (summaryPath) {
        const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>;
        state.result = {
          summaryPath,
          totals: summary.totals,
          bugsWritten: summary.bugsWritten as string[] | undefined,
          runIds: summary.runIds as string[] | undefined,
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
