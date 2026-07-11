import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execaSync } from 'execa';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorConfig } from '../src/config.js';
import { ensureSystemB } from '../src/provision.js';

let dir: string;

function configFor(repoPath: string, repoUrl?: string): ConnectorConfig {
  return {
    systemA: { repoPath: '/unused', bugsDir: 'docs/bugs', backlogFile: 'docs/sprints/backlog.md' },
    systemB: { repoPath, repoUrl, inputsDir: 'inputs/projects', reportsDir: 'reports' },
    roles: [],
    crawl: {},
    generation: {},
    run: {},
    summaryDir: 'runs',
    web: { port: 4000, workspaceDir: 'projects' },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provision-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureSystemB', () => {
  it('clones System B from repoUrl and installs deps on first use', async () => {
    // a local git repo standing in for the ai-automation-framework remote
    const origin = join(dir, 'origin');
    mkdirSync(origin);
    writeFileSync(join(origin, 'package.json'), '{"name":"stub-b","version":"1.0.0"}');
    execaSync('git', ['init', '-q'], { cwd: origin });
    execaSync('git', ['add', '-A'], { cwd: origin });
    execaSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'],
      { cwd: origin },
    );

    const target = join(dir, 'tools', 'system-b');
    await ensureSystemB(configFor(target, origin));
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    // npm install ran (a dep-less stub creates the lockfile, not node_modules)
    expect(existsSync(join(target, 'package-lock.json'))).toBe(true);
  });

  it('does nothing when the repo is missing and no repoUrl is set (preflight reports it)', async () => {
    const target = join(dir, 'nope');
    await ensureSystemB(configFor(target));
    expect(existsSync(target)).toBe(false);
  });

  it('leaves an already-provisioned checkout untouched', async () => {
    const target = join(dir, 'ready');
    mkdirSync(join(target, 'node_modules'), { recursive: true });
    writeFileSync(join(target, 'package.json'), '{}');
    writeFileSync(join(target, 'node_modules', 'marker.txt'), 'x');
    await ensureSystemB(configFor(target, 'https://example.invalid/should-not-be-used'));
    expect(existsSync(join(target, 'node_modules', 'marker.txt'))).toBe(true);
  });
});
