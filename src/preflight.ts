import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ConnectorConfig } from './config.js';

export interface PreflightIssue {
  level: 'error' | 'warn';
  message: string;
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Verify both repos exist and look runnable before doing anything.
 * Fails fast with messages that say exactly what to fix (NFR-2).
 * Never modifies either repo.
 */
export function preflight(config: ConnectorConfig): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const a = config.systemA;
  const b = config.systemB;

  // --- System A ---
  if (!dirExists(a.repoPath)) {
    issues.push({
      level: 'error',
      message: `System A repo not found: ${a.repoPath} — fix systemA.repoPath in connector.config.yaml`,
    });
  } else {
    const bugsDir = join(a.repoPath, a.bugsDir);
    if (!dirExists(bugsDir)) {
      issues.push({
        level: 'error',
        message: `System A bugs dir not found: ${bugsDir} — check systemA.bugsDir or create it in System A`,
      });
    }
    const backlogDir = dirname(join(a.repoPath, a.backlogFile));
    if (!dirExists(backlogDir)) {
      issues.push({
        level: 'error',
        message: `System A backlog dir not found: ${backlogDir} — check systemA.backlogFile`,
      });
    }
  }

  // --- System B ---
  if (!dirExists(b.repoPath)) {
    issues.push({
      level: 'error',
      message: `System B repo not found: ${b.repoPath} — fix systemB.repoPath in connector.config.yaml`,
    });
  } else {
    if (!existsSync(join(b.repoPath, 'package.json'))) {
      issues.push({
        level: 'error',
        message: `System B has no package.json at ${b.repoPath} — is this really the ai-automation-framework checkout?`,
      });
    }
    if (!dirExists(join(b.repoPath, 'node_modules'))) {
      issues.push({
        level: 'warn',
        message: `System B has no node_modules — run \`npm install\` in ${b.repoPath} first`,
      });
    }
    if (!dirExists(join(b.repoPath, b.inputsDir))) {
      issues.push({
        level: 'error',
        message: `System B inputs dir not found: ${join(b.repoPath, b.inputsDir)} — check systemB.inputsDir`,
      });
    }
    if (!dirExists(join(b.repoPath, b.reportsDir))) {
      issues.push({
        level: 'warn',
        message: `System B reports dir not found yet: ${join(b.repoPath, b.reportsDir)} — created by System B on first run`,
      });
    }
    for (const role of config.roles) {
      const recipe = join(b.repoPath, role.authRecipe);
      if (!existsSync(recipe)) {
        issues.push({
          level: 'error',
          message: `Auth recipe for role "${role.name}" not found: ${recipe} — prepare it in System B format first`,
        });
      }
    }
  }

  return issues;
}

export function hasErrors(issues: PreflightIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
