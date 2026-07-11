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
    // When set and repoPath doesn't exist yet, the connector clones
    // System B there automatically on first use (zero manual setup).
    repoUrl: z.string().optional(),
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
  // `connect web` — localhost project-factory UI.
  web: z
    .object({
      port: z.number().int().positive().default(4000),
      // Template to clone for new projects: local path or git URL of
      // web-automation-develop-template.
      templateRepo: z.string().optional(),
      // Where new project repos + their generated configs/logs live.
      workspaceDir: z.string().default('projects'),
    })
    .default({}),
  // One-place config for `connect pipeline`: requirement → System A
  // agents build → deploy → AI test → write-back, in a single command.
  pipeline: z
    .object({
      project: z.string().min(1),
      // Default requirement source; overridable per run with --requirement.
      requirementFile: z.string().optional(),
      // Build stage: the connector first writes the requirement into
      // `requirementDoc` (relative to System A's repo — template
      // convention docs/requirements/PS-001.md), then runs `commands` in
      // order inside System A's repo. Tokens: {requirementDoc} = that
      // relative path, {requirementFile} = absolute source file,
      // {requirement} = raw text (avoid for long documents — System A's
      // scripts choke on huge/quoted argv; reference the doc instead).
      // `command` (singular) is the pre-v0.2 shape, still accepted.
      build: z
        .object({
          requirementDoc: z.string().default('docs/requirements/PS-001.md'),
          commands: z.array(z.array(z.string().min(1)).min(1)).optional(),
          command: z.array(z.string().min(1)).min(1).optional(),
        })
        .transform((b) => ({
          requirementDoc: b.requirementDoc,
          commands: b.commands ?? (b.command ? [b.command] : []),
        }))
        .refine((b) => b.commands.length > 0, {
          message: 'build.commands là bắt buộc (hoặc build.command dạng cũ)',
        })
        .optional(),
      deploy: z.object({
        // Runs inside System A's repo, e.g. ["scripts/deploy.sh", "local"].
        command: z.array(z.string().min(1)).min(1),
        // Where the app will be reachable — becomes --url for the test stage.
        url: z.string().url(),
        healthTimeoutSec: z.number().int().positive().default(180),
      }),
    })
    .optional(),
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
