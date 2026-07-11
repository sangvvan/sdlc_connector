import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import type { ConnectorConfig } from './config.js';
import { cmd, ok } from './ui.js';

/**
 * One-time tool provisioning, run automatically before every chain so a
 * fresh machine needs nothing beyond the connector checkout itself:
 *
 * - System B missing on disk + `systemB.repoUrl` configured → clone it.
 * - System B present but never installed → `npm install` once.
 *
 * Silent no-op when everything is already in place. When the repo is
 * missing and no repoUrl is configured, this does nothing — preflight
 * reports the actionable error right after.
 */
export async function ensureSystemB(config: ConnectorConfig): Promise<void> {
  const repo = resolve(config.systemB.repoPath);

  if (!existsSync(repo)) {
    const url = config.systemB.repoUrl;
    if (!url) return;
    cmd(`git clone ${url} ${repo}`);
    await execa('git', ['clone', url, repo], { stdio: 'inherit' });
    ok(`System B cloned → ${repo}`);
  }

  if (existsSync(join(repo, 'package.json')) && !existsSync(join(repo, 'node_modules'))) {
    ok('System B: npm install (chỉ lần đầu, hơi lâu)...');
    await execa('npm', ['install'], { cwd: repo, stdio: 'inherit' });
    ok('System B dependencies installed');
  }
}
