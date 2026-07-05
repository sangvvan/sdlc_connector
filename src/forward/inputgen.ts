import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { ConnectorConfig } from '../config.js';

export interface InputGenOptions {
  project: string;
  baseUrl: string;
}

/**
 * Build the System B input YAML content
 * (`inputs/projects/{project}.yaml`: project, baseUrl, roles, crawl,
 * generation — see PROBLEM_STATEMENT §1/F2).
 *
 * crawl/generation come straight from connector config so any key
 * System B understands can be tuned without touching connector code.
 */
export function buildInputYaml(config: ConnectorConfig, opts: InputGenOptions): string {
  const doc: Record<string, unknown> = {
    project: opts.project,
    baseUrl: opts.baseUrl,
    roles: config.roles.map((r) =>
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

/** Write the input YAML into System B's inputs dir; returns the absolute path. */
export function writeInputFile(config: ConnectorConfig, opts: InputGenOptions): string {
  const content = buildInputYaml(config, opts);
  const abs = join(config.systemB.repoPath, config.systemB.inputsDir, `${opts.project}.yaml`);
  writeFileSync(abs, content, 'utf8');
  return abs;
}
