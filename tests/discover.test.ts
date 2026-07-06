import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ConnectorConfig } from '../src/config.js';
import {
  buildAuthRecipeYaml,
  discoverFromSystemA,
  isNonLocalTarget,
  plannedRecipes,
  rolesFromDiscovery,
} from '../src/discover/discover.js';
import { applyInputPlan, planInput } from '../src/forward/inputgen.js';

// Fixtures modeled on the REAL System A template files
// (app/lib/auth/roles.ts and docs/demo-accounts.md).
const ROLES_TS = `export const roles = ["employee", "manager", "admin", "competence_lead"] as const;

export type Role = (typeof roles)[number];
`;

const ACCOUNTS_MD = `# Demo accounts

**Password for every account below: \`Password123!\`** — works in both modes.

Sign in at \`/auth/login\`.

| Role            | Email                       | What you see after sign-in |
|-----------------|-----------------------------|-----------------------------|
| employee        | \`employee@example.com\`      | dashboard |
| manager         | \`manager@example.com\`       | team view |
| admin           | \`admin@example.com\`         | admin UI |
| competence_lead | \`competence@example.com\`    | reports |

Extra employees (also \`Password123!\`) used as the manager's team:

| Email                         | Name           | Role     |
|-------------------------------|----------------|----------|
| \`ben.engineer@example.com\`    | Ben Engineer   | employee |
`;

let repoA: string;
let repoB: string;

function configFor(): ConnectorConfig {
  return {
    systemA: { repoPath: repoA, bugsDir: 'docs/bugs', backlogFile: 'docs/sprints/backlog.md' },
    systemB: { repoPath: repoB, inputsDir: 'inputs/projects', reportsDir: 'reports' },
    roles: [],
    crawl: { maxPages: 2 },
    generation: {},
    run: {},
    summaryDir: 'runs',
  };
}

function seedSystemA(): void {
  mkdirSync(join(repoA, 'app/lib/auth'), { recursive: true });
  mkdirSync(join(repoA, 'docs'), { recursive: true });
  writeFileSync(join(repoA, 'app/lib/auth/roles.ts'), ROLES_TS);
  writeFileSync(join(repoA, 'docs/demo-accounts.md'), ACCOUNTS_MD);
}

beforeEach(() => {
  repoA = mkdtempSync(join(tmpdir(), 'system-a-'));
  repoB = mkdtempSync(join(tmpdir(), 'system-b-'));
  mkdirSync(join(repoB, 'inputs/projects'), { recursive: true });
});

afterEach(() => {
  rmSync(repoA, { recursive: true, force: true });
  rmSync(repoB, { recursive: true, force: true });
});

describe('discoverFromSystemA', () => {
  it('reads roles, accounts, password and login path from template conventions', () => {
    seedSystemA();
    const d = discoverFromSystemA(repoA)!;
    expect(d.roles).toEqual(['employee', 'manager', 'admin', 'competence_lead']);
    expect(d.accounts).toHaveLength(4);
    expect(d.accounts[2]).toEqual({ role: 'admin', email: 'admin@example.com' });
    expect(d.password).toBe('Password123!');
    expect(d.loginPath).toBe('/auth/login');
    expect(d.warnings).toEqual([]);
  });

  it('ignores the extra-employees table (Email | Name | Role order)', () => {
    seedSystemA();
    const d = discoverFromSystemA(repoA)!;
    expect(d.accounts.some((a) => a.email === 'ben.engineer@example.com')).toBe(false);
  });

  it('returns undefined when source files are missing (fallback to config)', () => {
    expect(discoverFromSystemA(repoA)).toBeUndefined();
  });

  it('warns about roles without a demo account', () => {
    seedSystemA();
    writeFileSync(
      join(repoA, 'app/lib/auth/roles.ts'),
      'export const roles = ["admin", "auditor"] as const;',
    );
    const d = discoverFromSystemA(repoA)!;
    expect(d.warnings.some((w) => w.includes('"auditor"'))).toBe(true);
  });
});

describe('buildAuthRecipeYaml', () => {
  it("produces System B's AuthRecipe shape with template login-form locators", () => {
    seedSystemA();
    const d = discoverFromSystemA(repoA)!;
    const doc = parse(
      buildAuthRecipeYaml({ role: 'admin', email: 'admin@example.com' }, d, 'demo', 'http://localhost:3000'),
    ) as {
      id: string;
      loginUrl: string;
      fields: { username: unknown; password: { value: string } };
      submit: { locator: unknown };
    };
    expect(doc.id).toBe('demo-admin');
    expect(doc.loginUrl).toBe('http://localhost:3000/auth/login');
    expect(doc.fields.username).toEqual({
      locator: { kind: 'role', role: 'textbox', name: 'Email' },
      value: 'admin@example.com',
    });
    expect(doc.fields.password.value).toBe('Password123!');
    expect(doc.submit.locator).toEqual({ kind: 'role', role: 'button', name: 'Sign in' });
  });
});

describe('planInput priority', () => {
  it('1: reuses an existing System B input file, updating only baseUrl/project', () => {
    seedSystemA(); // discovery available but must NOT win
    writeFileSync(
      join(repoB, 'inputs/projects/demo.yaml'),
      'project: demo\nbaseUrl: http://old:1\nroles:\n  - name: custom\ncrawl:\n  maxPages: 99\n',
    );
    const applied = applyInputPlan(configFor(), { project: 'demo', baseUrl: 'http://new:2' });
    expect(applied.plan.mode).toBe('reuse');
    const doc = parse(readFileSync(applied.plan.path, 'utf8')) as {
      baseUrl: string;
      roles: unknown;
      crawl: { maxPages: number };
    };
    expect(doc.baseUrl).toBe('http://new:2');
    expect(doc.roles).toEqual([{ name: 'custom' }]); // untouched
    expect(doc.crawl.maxPages).toBe(99); // untouched
  });

  it('2: discovers from System A when no input exists, writing recipes into System B', () => {
    seedSystemA();
    const applied = applyInputPlan(configFor(), { project: 'demo', baseUrl: 'http://localhost:3000' });
    expect(applied.plan.mode).toBe('discovered');
    expect(applied.recipes).toHaveLength(4);
    expect(readFileSync(join(repoB, 'inputs/auth/demo-admin.yaml'), 'utf8')).toContain(
      'admin@example.com',
    );
    const doc = parse(readFileSync(applied.plan.path, 'utf8')) as { roles: unknown[] };
    expect(doc.roles).toContainEqual({ name: 'admin', authRecipe: 'inputs/auth/demo-admin.yaml' });
  });

  it('3: falls back to connector config roles when discovery is unavailable', () => {
    const config = { ...configFor(), roles: [{ name: 'admin' }] };
    const applied = applyInputPlan(config, { project: 'demo', baseUrl: 'http://localhost:3000' });
    expect(applied.plan.mode).toBe('config');
    expect(applied.roleCount).toBe(1);
  });

  it('fails with an actionable message when no role source exists', () => {
    expect(() => planInput(configFor(), { project: 'demo', baseUrl: 'http://x' })).toThrow(
      /Add roles to one of the three/,
    );
  });
});

describe('helpers', () => {
  it('rolesFromDiscovery attaches recipes only where accounts exist', () => {
    seedSystemA();
    writeFileSync(
      join(repoA, 'app/lib/auth/roles.ts'),
      'export const roles = ["admin", "auditor"] as const;',
    );
    const d = discoverFromSystemA(repoA)!;
    const roles = rolesFromDiscovery(d, plannedRecipes(d, 'demo'));
    expect(roles).toContainEqual({ name: 'admin', authRecipe: 'inputs/auth/demo-admin.yaml' });
    expect(roles).toContainEqual({ name: 'auditor' });
  });

  it('isNonLocalTarget flags anything that is not localhost', () => {
    expect(isNonLocalTarget('http://localhost:3000')).toBe(false);
    expect(isNonLocalTarget('http://127.0.0.1:3000')).toBe(false);
    expect(isNonLocalTarget('https://staging.example.com')).toBe(true);
  });
});
