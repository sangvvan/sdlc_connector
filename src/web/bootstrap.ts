import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import type { ConnectorConfig } from '../config.js';

/**
 * Project bootstrap for `connect web`: turn one form submission into the
 * on-disk layout the pipeline needs — a cloned template repo, a
 * requirement file, and a generated per-project connector config.
 * Everything lands under web.workspaceDir:
 *
 *   {workspace}/{name}/                  ← clone of the System A template
 *   {workspace}/{name}.requirement.md
 *   {workspace}/{name}.connector.yaml    ← config for `connect pipeline`
 *   {workspace}/{name}.log               ← job output (jobs.ts)
 *   {workspace}/{name}.state.json        ← job state (jobs.ts)
 *   {workspace}/{name}.runs/             ← run summaries
 */

export const AI_PROVIDERS = ['claude', 'codex', 'gemini', 'opencode'] as const;
export const DEPLOY_TARGETS = [
  'local',
  'staging aws',
  'staging azure',
  'staging vercel',
  'production aws',
  'production azure',
  'production vercel',
] as const;

export interface NewProjectRequest {
  name: string;
  requirement: string;
  techStack?: string;
  aiProvider: string;
  deployTarget: string;
  url: string;
  skipBuild?: boolean;
  skipDeploy?: boolean;
}

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** Validate a form submission; returns a list of human-readable problems. */
export function validateRequest(req: NewProjectRequest): string[] {
  const problems: string[] = [];
  if (!NAME_RE.test(req.name ?? '')) {
    problems.push('Tên project: chữ thường/số/gạch ngang, bắt đầu bằng chữ (vd: course-catalog)');
  }
  if (!req.requirement || req.requirement.trim().length < 10) {
    problems.push('Problem statement / requirement quá ngắn');
  }
  if (!(AI_PROVIDERS as readonly string[]).includes(req.aiProvider)) {
    problems.push(`AI provider phải là một trong: ${AI_PROVIDERS.join(', ')}`);
  }
  if (!(DEPLOY_TARGETS as readonly string[]).includes(req.deployTarget)) {
    problems.push(`Deploy target phải là một trong: ${DEPLOY_TARGETS.join(' | ')}`);
  }
  try {
    new URL(req.url);
  } catch {
    problems.push('URL app không hợp lệ (vd: http://localhost:3000)');
  }
  return problems;
}

/** Requirement file content: the statement plus an optional tech-stack section. */
export function composeRequirement(req: NewProjectRequest): string {
  let out = req.requirement.trim() + '\n';
  if (req.techStack?.trim()) {
    out += `\n## Tech stack\n\n${req.techStack.trim()}\n`;
  }
  return out;
}

export interface ProjectPaths {
  dir: string;
  requirementFile: string;
  configFile: string;
  logFile: string;
  stateFile: string;
  summaryDir: string;
}

export function projectPaths(config: ConnectorConfig, name: string): ProjectPaths {
  const ws = resolve(config.web.workspaceDir);
  return {
    dir: join(ws, name),
    requirementFile: join(ws, `${name}.requirement.md`),
    configFile: join(ws, `${name}.connector.yaml`),
    logFile: join(ws, `${name}.log`),
    stateFile: join(ws, `${name}.state.json`),
    summaryDir: join(ws, `${name}.runs`),
  };
}

/**
 * Generate the per-project connector config. System A = the freshly
 * cloned project repo; System B and crawl/generation/run defaults are
 * inherited from the base config the web server was started with.
 */
export function buildProjectConfigYaml(
  config: ConnectorConfig,
  req: NewProjectRequest,
  paths: ProjectPaths,
): string {
  const deployArgs = req.deployTarget.split(' ');
  return stringify({
    systemA: { repoPath: paths.dir },
    systemB: {
      repoPath: resolve(config.systemB.repoPath),
      inputsDir: config.systemB.inputsDir,
      reportsDir: config.systemB.reportsDir,
    },
    crawl: config.crawl,
    generation: config.generation,
    run: config.run,
    summaryDir: paths.summaryDir,
    pipeline: {
      project: req.name,
      requirementFile: paths.requirementFile,
      // The connector writes the requirement to requirementDoc first,
      // then: /ps turns it into REQ-*.md, /feature all runs the full
      // phase pipeline for every generated requirement. run.sh only
      // accepts short prompts/ids as argv — never the whole document.
      build: {
        requirementDoc: 'docs/requirements/PS-001.md',
        commands: [
          [
            'scripts/legacy/run.sh',
            '/ps',
            'Generate versioned requirements (REQ-*.md) from {requirementDoc}',
            `--provider=${req.aiProvider}`,
          ],
          ['scripts/legacy/run.sh', '/feature', 'all', `--provider=${req.aiProvider}`],
        ],
      },
      deploy: {
        command: ['scripts/deploy.sh', ...deployArgs],
        url: req.url,
        healthTimeoutSec: 300,
      },
    },
  });
}

/** Write requirement + generated config to disk (repo clone happens in jobs.ts). */
export function writeProjectFiles(
  config: ConnectorConfig,
  req: NewProjectRequest,
  paths: ProjectPaths,
): void {
  mkdirSync(resolve(config.web.workspaceDir), { recursive: true });
  writeFileSync(paths.requirementFile, composeRequirement(req), 'utf8');
  writeFileSync(paths.configFile, buildProjectConfigYaml(config, req, paths), 'utf8');
}
