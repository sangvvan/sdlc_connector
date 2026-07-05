import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { buildInputYaml } from '../src/forward/inputgen.js';

const FIXTURE_CONFIG = fileURLToPath(new URL('../fixtures/sample-config.yaml', import.meta.url));

describe('buildInputYaml', () => {
  // Load through the real loader to exercise zod defaults too.
  const config = loadConfig(FIXTURE_CONFIG);
  const yamlText = buildInputYaml(config, {
    project: 'demo',
    baseUrl: 'https://app.example.com',
  });
  const doc = parse(yamlText) as Record<string, unknown>;

  it('produces valid YAML with the System B input top-level keys', () => {
    expect(doc.project).toBe('demo');
    expect(doc.baseUrl).toBe('https://app.example.com');
    expect(doc.roles).toBeDefined();
    expect(doc.crawl).toBeDefined();
  });

  it('carries roles with authRecipe paths from connector config', () => {
    const roles = z.array(z.object({ name: z.string(), authRecipe: z.string() })).parse(doc.roles);
    expect(roles).toEqual([
      { name: 'admin', authRecipe: 'inputs/auth/admin.yaml' },
      { name: 'user', authRecipe: 'inputs/auth/user.yaml' },
    ]);
  });

  it('passes crawl settings through verbatim', () => {
    expect(doc.crawl).toEqual({ maxPages: 50, maxDepth: 3 });
  });

  it('includes generation block when configured', () => {
    expect(doc.generation).toEqual({ testLevel: 'system' });
  });
});

describe('loadConfig', () => {
  it('applies path defaults', () => {
    const config = loadConfig(FIXTURE_CONFIG);
    expect(config.systemA.bugsDir).toBe('docs/bugs');
    expect(config.systemA.backlogFile).toBe('docs/sprints/backlog.md');
    expect(config.systemB.inputsDir).toBe('inputs/projects');
    expect(config.systemB.reportsDir).toBe('reports');
  });

  it('fails with an actionable message when the file is missing', () => {
    expect(() => loadConfig('/nonexistent/connector.config.yaml')).toThrow(
      /connector\.config\.example\.yaml/,
    );
  });
});
