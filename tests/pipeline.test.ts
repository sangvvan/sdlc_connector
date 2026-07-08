import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { substituteTokens, waitForUrl } from '../src/pipeline/pipeline.js';
import { loadConfig } from '../src/config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
