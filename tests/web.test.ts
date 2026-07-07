import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ConnectorConfig } from '../src/config.js';
import {
  buildProjectConfigYaml,
  composeRequirement,
  projectPaths,
  validateRequest,
  writeProjectFiles,
  type NewProjectRequest,
} from '../src/web/bootstrap.js';

let ws: string;

function baseConfig(): ConnectorConfig {
  return {
    systemA: { repoPath: '/unused', bugsDir: 'docs/bugs', backlogFile: 'docs/sprints/backlog.md' },
    systemB: { repoPath: '/opt/system-b', inputsDir: 'inputs/projects', reportsDir: 'reports' },
    roles: [],
    crawl: { maxPages: 30 },
    generation: {},
    run: { testLevel: 'system' },
    summaryDir: 'runs',
    web: { port: 4000, templateRepo: '/opt/template', workspaceDir: ws },
  };
}

function validReq(): NewProjectRequest {
  return {
    name: 'course-catalog',
    requirement: 'Build a course catalog web app for internal training.',
    techStack: 'Remix + PostgreSQL',
    aiProvider: 'claude',
    deployTarget: 'local',
    url: 'http://localhost:3000',
  };
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'factory-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('validateRequest', () => {
  it('accepts a valid submission', () => {
    expect(validateRequest(validReq())).toEqual([]);
  });

  it('rejects bad names, unknown providers/targets, bad urls', () => {
    const problems = validateRequest({
      ...validReq(),
      name: 'Bad Name!',
      aiProvider: 'gpt-99',
      deployTarget: 'ftp',
      url: 'not-a-url',
    });
    expect(problems).toHaveLength(4);
  });

  it('rejects an empty requirement', () => {
    expect(validateRequest({ ...validReq(), requirement: '  ' })).toHaveLength(1);
  });
});

describe('composeRequirement', () => {
  it('appends the tech-stack section when provided', () => {
    const out = composeRequirement(validReq());
    expect(out).toContain('course catalog');
    expect(out).toContain('## Tech stack');
    expect(out).toContain('Remix + PostgreSQL');
  });

  it('omits the section when tech stack is empty', () => {
    expect(composeRequirement({ ...validReq(), techStack: '' })).not.toContain('## Tech stack');
  });
});

describe('buildProjectConfigYaml', () => {
  it('generates a pipeline config wired to the cloned repo and chosen options', () => {
    const config = baseConfig();
    const req = { ...validReq(), aiProvider: 'codex', deployTarget: 'staging vercel' };
    const paths = projectPaths(config, req.name);
    const doc = parse(buildProjectConfigYaml(config, req, paths)) as {
      systemA: { repoPath: string };
      systemB: { repoPath: string };
      crawl: { maxPages: number };
      pipeline: {
        project: string;
        build: { command: string[] };
        deploy: { command: string[]; url: string };
      };
    };
    expect(doc.systemA.repoPath).toBe(paths.dir);
    expect(doc.systemB.repoPath).toBe('/opt/system-b');
    expect(doc.crawl.maxPages).toBe(30); // inherited defaults
    expect(doc.pipeline.project).toBe('course-catalog');
    expect(doc.pipeline.build.command).toContain('--provider=codex');
    expect(doc.pipeline.deploy.command).toEqual(['scripts/deploy.sh', 'staging', 'vercel']);
    expect(doc.pipeline.deploy.url).toBe('http://localhost:3000');
  });
});

describe('writeProjectFiles', () => {
  it('writes requirement + config into the workspace', () => {
    const config = baseConfig();
    const req = validReq();
    const paths = projectPaths(config, req.name);
    writeProjectFiles(config, req, paths);
    expect(readFileSync(paths.requirementFile, 'utf8')).toContain('course catalog');
    const cfg = parse(readFileSync(paths.configFile, 'utf8')) as {
      pipeline: { requirementFile: string };
    };
    expect(cfg.pipeline.requirementFile).toBe(paths.requirementFile);
  });
});
