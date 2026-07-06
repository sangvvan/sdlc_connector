import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { ConnectorConfig, Role } from '../config.js';
import {
  discoverFromSystemA,
  writeAuthRecipes,
  rolesFromDiscovery,
  type Discovery,
  type WrittenRecipe,
} from '../discover/discover.js';

export interface InputGenOptions {
  project: string;
  baseUrl: string;
}

/**
 * Build the System B input YAML content
 * (`inputs/projects/{project}.yaml`: project, baseUrl, roles, crawl,
 * generation, run — matches System B's WorkflowInput schema).
 *
 * crawl/generation/run come straight from connector config so any key
 * System B understands can be tuned without touching connector code.
 */
export function buildInputYaml(
  config: ConnectorConfig,
  opts: InputGenOptions,
  roles: Role[] = config.roles,
): string {
  const doc: Record<string, unknown> = {
    project: opts.project,
    baseUrl: opts.baseUrl,
    roles: roles.map((r) =>
      r.authRecipe ? { name: r.name, authRecipe: r.authRecipe } : { name: r.name },
    ),
    crawl: config.crawl,
  };
  if (Object.keys(config.generation).length > 0) {
    doc.generation = config.generation;
  }
  if (Object.keys(config.run).length > 0) {
    doc.run = config.run;
  }
  return stringify(doc);
}

export type InputMode = 'reuse' | 'discovered' | 'config';

export interface InputPlan {
  mode: InputMode;
  /** Absolute path the input YAML will be written to. */
  path: string;
  /** Set when mode === 'discovered'. */
  discovery?: Discovery;
}

/**
 * Decide where the System B input comes from, in priority order:
 *
 * 1. `reuse` — `inputs/projects/{project}.yaml` already exists in System B
 *    (the project was configured there before): respect it as the source
 *    of truth, only the baseUrl is updated.
 * 2. `discovered` — a fresh project: pull roles + demo accounts from
 *    System A (app/lib/auth/roles.ts + docs/demo-accounts.md) and
 *    generate System B auth recipes automatically.
 * 3. `config` — fall back to roles declared in connector.config.yaml.
 *
 * Throws with an actionable message when no source is available.
 */
export function planInput(config: ConnectorConfig, opts: InputGenOptions): InputPlan {
  const path = join(config.systemB.repoPath, config.systemB.inputsDir, `${opts.project}.yaml`);
  if (existsSync(path)) {
    return { mode: 'reuse', path };
  }
  const discovery = discoverFromSystemA(config.systemA.repoPath);
  if (discovery) {
    return { mode: 'discovered', path, discovery };
  }
  if (config.roles.length > 0) {
    return { mode: 'config', path };
  }
  throw new Error(
    `No role source for project "${opts.project}": System B has no ` +
      `${config.systemB.inputsDir}/${opts.project}.yaml, System A has no discoverable ` +
      `roles (app/lib/auth/roles.ts + docs/demo-accounts.md), and connector.config.yaml ` +
      `declares no roles. Add roles to one of the three.`,
  );
}

export interface AppliedInput {
  plan: InputPlan;
  /** Recipes generated in System B (discovered mode only). */
  recipes: WrittenRecipe[];
  /** Roles that ended up in the input YAML. */
  roleCount: number;
}

/** Execute an InputPlan: write recipes (if discovered) and the input YAML. */
export function applyInputPlan(config: ConnectorConfig, opts: InputGenOptions): AppliedInput {
  const plan = planInput(config, opts);

  if (plan.mode === 'reuse') {
    const existing = parse(readFileSync(plan.path, 'utf8')) as Record<string, unknown>;
    existing.baseUrl = opts.baseUrl;
    existing.project = opts.project;
    writeFileSync(plan.path, stringify(existing), 'utf8');
    const roles = Array.isArray(existing.roles) ? existing.roles.length : 0;
    return { plan, recipes: [], roleCount: roles };
  }

  if (plan.mode === 'discovered') {
    const recipes = writeAuthRecipes(config, plan.discovery!, opts.project, opts.baseUrl);
    const roles = rolesFromDiscovery(plan.discovery!, recipes);
    writeFileSync(plan.path, buildInputYaml(config, opts, roles), 'utf8');
    return { plan, recipes, roleCount: roles.length };
  }

  writeFileSync(plan.path, buildInputYaml(config, opts), 'utf8');
  return { plan, recipes: [], roleCount: config.roles.length };
}
