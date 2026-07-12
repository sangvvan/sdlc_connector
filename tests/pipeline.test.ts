import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import {
  ensureDevEnv,
  findFreePort,
  requirementsChanged,
  runStageCommand,
  snapshotRequirements,
  parametrizePostgresPort,
  prepareLocalDeploy,
  substituteTokens,
  waitForUrl,
} from '../src/pipeline/pipeline.js';
import { loadConfig } from '../src/config.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
    server = createHttpServer((_req, res) => {
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

const COMPOSE = [
  'services:',
  '  postgres:',
  '    ports:',
  '      - "127.0.0.1:5433:5432"',
  '  app:',
  '    ports:',
  '      - "${LOCAL_PORT:-3000}:3000"',
].join('\n');

describe('runStageCommand stdin handling', () => {
  it(
    'never blocks a child waiting for stdin — EOF is delivered (cat exits immediately)',
    async () => {
      // regression: a rate-limited claude CLI printing 'Reading additional
      // input from stdin...' used to hang jobs forever on an open pipe.
      await expect(runStageCommand(['cat'], process.cwd())).resolves.toBeUndefined();
    },
    5000,
  );
});

describe('requirements tripwire (silent template failures)', () => {
  it('detects nothing changed when the build was a no-op — template examples do not count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'req-'));
    try {
      const reqDir = join(dir, 'docs', 'requirements');
      mkdirSync(reqDir, { recursive: true });
      // the template SHIPS example REQ files — pre-existing must not count
      writeFileSync(join(reqDir, 'REQ-001.md'), 'shipped example');
      writeFileSync(join(reqDir, 'PS-001.md'), 'ps');
      const before = snapshotRequirements(dir);
      expect(requirementsChanged(dir, before)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects a newly generated REQ file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'req-'));
    try {
      const reqDir = join(dir, 'docs', 'requirements');
      mkdirSync(reqDir, { recursive: true });
      writeFileSync(join(reqDir, 'REQ-001.md'), 'shipped');
      const before = snapshotRequirements(dir);
      writeFileSync(join(reqDir, 'REQ-010.md'), 'generated by /ps');
      expect(requirementsChanged(dir, before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects a rewritten REQ file (mtime bump)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'req-'));
    try {
      const reqDir = join(dir, 'docs', 'requirements');
      mkdirSync(reqDir, { recursive: true });
      const f = join(reqDir, 'REQ-001.md');
      writeFileSync(f, 'v1');
      const before = snapshotRequirements(dir);
      utimesSync(f, new Date(), new Date(Date.now() + 5000));
      expect(requirementsChanged(dir, before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('empty snapshot when the requirements dir is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'req-'));
    try {
      expect(snapshotRequirements(dir)).toEqual({});
      expect(requirementsChanged(dir, {})).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('per-project port isolation (prepareLocalDeploy)', () => {
  const ENV_EXAMPLE = [
    'BASE_URL=http://localhost:3000',
    'POSTGRES_PASSWORD=CHANGE_ME_pw',
    'DATABASE_URL=postgresql://app:CHANGE_ME_pw@localhost:5433/app_dev',
    'SESSION_SECRET=CHANGE_ME_secret',
  ].join('\n');

  it('parametrizes the postgres host port in the cloned compose file, idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iso-'));
    try {
      writeFileSync(join(dir, 'docker-compose.yml'), COMPOSE);
      expect(parametrizePostgresPort(dir)).toBe(true);
      const patched = readFileSync(join(dir, 'docker-compose.yml'), 'utf8');
      expect(patched).toContain('127.0.0.1:${POSTGRES_HOST_PORT:-5433}:5432');
      // second call: already parametrized, no double-patch
      expect(parametrizePostgresPort(dir)).toBe(true);
      expect(readFileSync(join(dir, 'docker-compose.yml'), 'utf8')).toBe(patched);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when there is no compose file or no known binding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iso-'));
    try {
      expect(parametrizePostgresPort(dir)).toBe(false);
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}');
      expect(parametrizePostgresPort(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assigns LOCAL_PORT from the app URL and a free postgres port, keeping DATABASE_URL in sync', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iso-'));
    // Occupy 5433 so the allocator must pick another port — the real
    // "second project while the first is running" situation.
    const blocker = createServer();
    await new Promise<void>((done) => {
      blocker.once('error', () => done()); // already busy = same effect
      blocker.listen(5433, '127.0.0.1', () => done());
    });
    try {
      writeFileSync(join(dir, '.env.example'), ENV_EXAMPLE);
      writeFileSync(join(dir, 'docker-compose.yml'), COMPOSE);
      const prep = await prepareLocalDeploy(dir, 'http://localhost:3010');
      expect(prep.envCreated).toBe(true);
      expect(prep.appPort).toBe('3010');
      expect(prep.pgPort).toBeDefined();
      expect(prep.pgPort).not.toBe('5433');
      const env = readFileSync(join(dir, '.env'), 'utf8');
      expect(env).toContain('LOCAL_PORT=3010');
      expect(env).toContain('BASE_URL=http://localhost:3010');
      expect(env).toContain(`POSTGRES_HOST_PORT=${prep.pgPort}`);
      expect(env).toContain(`localhost:${prep.pgPort}/app_dev`);
      expect(env).not.toContain('localhost:5433');
    } finally {
      blocker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-deploys reuse the ports already recorded in .env', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iso-'));
    try {
      writeFileSync(join(dir, '.env.example'), ENV_EXAMPLE);
      writeFileSync(join(dir, 'docker-compose.yml'), COMPOSE);
      const first = await prepareLocalDeploy(dir, 'http://localhost:3010');
      const second = await prepareLocalDeploy(dir, 'http://localhost:3010');
      expect(second.pgPort).toBe(first.pgPort);
      expect(second.envCreated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('findFreePort returns a port at or above the requested start', async () => {
    const port = await findFreePort(5433);
    expect(port).toBeGreaterThanOrEqual(5433);
    expect(port).toBeLessThan(5533);
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
