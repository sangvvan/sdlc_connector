import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ensureDevEnv, substituteTokens, waitForUrl } from '../src/pipeline/pipeline.js';
import { loadConfig } from '../src/config.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('substituteTokens', () => {
  const tokens = {
    requirement: 'Build a course catalog',
    requirementFile: '/abs/req.md',
    requirementDoc: 'docs/requirements/PS-001.md',
  };

  it('replaces all three tokens in the configured command', () => {
    const out = substituteTokens(
      ['run.sh', '/ps', 'Generate REQs from {requirementDoc}', '--file={requirementFile}', '{requirement}'],
      tokens,
    );
    expect(out).toEqual([
      'run.sh',
      '/ps',
      'Generate REQs from docs/requirements/PS-001.md',
      '--file=/abs/req.md',
      'Build a course catalog',
    ]);
  });

  it('leaves commands without tokens untouched', () => {
    expect(substituteTokens(['scripts/deploy.sh', 'local'], tokens)).toEqual([
      'scripts/deploy.sh',
      'local',
    ]);
  });
});

describe('waitForUrl', () => {
  let server: Server;
  let url: string;
  let status = 200;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.statusCode = status;
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`;
  });

  afterAll(() => {
    server.close();
  });

  it('resolves when the app answers', async () => {
    status = 200;
    await expect(waitForUrl(url, 5, 100)).resolves.toBeUndefined();
  });

  it('accepts redirects/404s as "up" (server is serving)', async () => {
    status = 404;
    await expect(waitForUrl(url, 5, 100)).resolves.toBeUndefined();
  });

  it('times out with an actionable error when nothing answers', async () => {
    await expect(waitForUrl('http://127.0.0.1:1/', 1, 100)).rejects.toThrow(/not healthy after 1s/);
  });

  it('keeps polling through 5xx until timeout', async () => {
    status = 503;
    await expect(waitForUrl(url, 1, 100)).rejects.toThrow(/HTTP 503/);
  });
});

describe('ensureDevEnv', () => {
  const EXAMPLE = [
    'NODE_ENV=development',
    'POSTGRES_PASSWORD=CHANGE_ME_use_a_strong_password',
    'DATABASE_URL=postgresql://app:CHANGE_ME_use_a_strong_password@localhost:5433/app_dev',
    'SESSION_SECRET=CHANGE_ME_run_openssl_rand_hex_32',
  ].join('\n');

  it('creates .env from .env.example with consistent random secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-'));
    try {
      writeFileSync(join(dir, '.env.example'), EXAMPLE);
      expect(ensureDevEnv(dir)).toBe('created');
      const env = readFileSync(join(dir, '.env'), 'utf8');
      expect(env).not.toContain('CHANGE_ME');
      const pw = /POSTGRES_PASSWORD=(\w+)/.exec(env)![1];
      // the same placeholder gets the same generated value everywhere
      expect(env).toContain(`postgresql://app:${pw}@localhost:5433/app_dev`);
      const secret = /SESSION_SECRET=(\w+)/.exec(env)![1];
      expect(secret).not.toBe(pw);
      expect(secret!.length).toBeGreaterThanOrEqual(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never overwrites an existing .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-'));
    try {
      writeFileSync(join(dir, '.env.example'), EXAMPLE);
      writeFileSync(join(dir, '.env'), 'SESSION_SECRET=mine\n');
      expect(ensureDevEnv(dir)).toBe('exists');
      expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('SESSION_SECRET=mine\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when the repo has no .env.example', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-'));
    try {
      expect(ensureDevEnv(dir)).toBe('no-template');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('config pipeline block', () => {
  it('parses a full pipeline config with defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    try {
      const file = join(dir, 'c.yaml');
      writeFileSync(
        file,
        [
          'systemA:',
          '  repoPath: /a',
          'systemB:',
          '  repoPath: /b',
          'pipeline:',
          '  project: demo',
          '  requirementFile: requirement.md',
          '  build:',
          '    commands:',
          '      - ["scripts/legacy/run.sh", "/ps", "Generate REQs from {requirementDoc}"]',
          '      - ["scripts/legacy/run.sh", "/feature", "all"]',
          '  deploy:',
          '    command: ["scripts/deploy.sh", "local"]',
          '    url: http://localhost:3000',
        ].join('\n'),
      );
      const config = loadConfig(file);
      expect(config.pipeline?.project).toBe('demo');
      expect(config.pipeline?.deploy.healthTimeoutSec).toBe(180);
      expect(config.pipeline?.build?.requirementDoc).toBe('docs/requirements/PS-001.md');
      expect(config.pipeline?.build?.commands).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts the legacy build.command shape (pre-v0.2 configs)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    try {
      const file = join(dir, 'c.yaml');
      writeFileSync(
        file,
        [
          'systemA:',
          '  repoPath: /a',
          'systemB:',
          '  repoPath: /b',
          'pipeline:',
          '  project: demo',
          '  build:',
          '    command: ["scripts/legacy/run.sh", "/feature", "all"]',
          '  deploy:',
          '    command: ["scripts/deploy.sh", "local"]',
          '    url: http://localhost:3000',
        ].join('\n'),
      );
      const config = loadConfig(file);
      expect(config.pipeline?.build?.commands).toEqual([
        ['scripts/legacy/run.sh', '/feature', 'all'],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays optional — configs without pipeline still load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    try {
      const file = join(dir, 'c.yaml');
      writeFileSync(file, 'systemA:\n  repoPath: /a\nsystemB:\n  repoPath: /b\n');
      expect(loadConfig(file).pipeline).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
