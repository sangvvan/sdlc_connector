import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const roleSchema = z.object({
  name: z.string().min(1),
  // Relative to System B's repo root; must exist when set (preflight
  // checks). Optional — System B can auto-bootstrap an auth recipe by
  // detecting the login form (lib/workflow/bootstrap.ts).
  authRecipe: z.string().min(1).optional(),
});

const configSchema = z.object({
  systemA: z.object({
    repoPath: z.string().min(1),
    bugsDir: z.string().default('docs/bugs'),
    backlogFile: z.string().default('docs/sprints/backlog.md'),
  }),
  systemB: z.object({
    repoPath: z.string().min(1),
    inputsDir: z.string().default('inputs/projects'),
    reportsDir: z.string().default('reports'),
  }),
  // Optional: only the fallback source of roles. Priority order is
  // System B's existing inputs/projects/{p}.yaml > discovery from
  // System A (roles.ts + demo-accounts.md) > this list.
  roles: z.array(roleSchema).default([]),
  // Passed through verbatim into the generated input YAML so any key
  // System B understands works without a connector code change.
  crawl: z.record(z.unknown()).default({ maxPages: 50, maxDepth: 3 }),
  generation: z.record(z.unknown()).default({}),
  run: z.record(z.unknown()).default({}),
  summaryDir: z.string().default('runs'),
});

export type ConnectorConfig = z.infer<typeof configSchema>;
export type Role = z.infer<typeof roleSchema>;

export function loadConfig(configPath = 'connector.config.yaml'): ConnectorConfig {
  const abs = resolve(configPath);
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch {
    throw new Error(
      `Config not found: ${abs}\n` +
        `Fix: cp connector.config.example.yaml connector.config.yaml and edit the repo paths.`,
    );
  }
  const parsed: unknown = parse(raw);
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config ${abs}:\n${issues}`);
  }
  return result.data;
}
