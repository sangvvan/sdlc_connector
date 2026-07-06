import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { ConnectorConfig, Role } from '../config.js';

/**
 * Role/account discovery: System A already contains everything System B
 * needs to authenticate — the connector transfers it so a fresh project
 * needs zero manual System B config.
 *
 * Sources (System A template conventions):
 * - `app/lib/auth/roles.ts` — `export const roles = ["employee", ...]`
 * - `docs/demo-accounts.md`  — role → email table, shared demo password,
 *   and the login path ("Sign in at `/auth/login`")
 *
 * The generated auth recipes use the template's login-form accessibility
 * names (Email / Password / Sign in — see tests/pom/LoginPage.ts in the
 * template), which map 1-1 onto System B's role-based locators.
 *
 * If either source file is missing or unparseable, discovery returns
 * undefined and the caller falls back to connector-config roles.
 */

export interface DiscoveredAccount {
  role: string;
  email: string;
}

export interface Discovery {
  /** All roles declared in app/lib/auth/roles.ts, in order. */
  roles: string[];
  /** role → demo account email (roles without an account get no recipe). */
  accounts: DiscoveredAccount[];
  /** Shared demo password from docs/demo-accounts.md. */
  password: string;
  /** Login path, e.g. "/auth/login". */
  loginPath: string;
  warnings: string[];
}

const ROLES_FILE = 'app/lib/auth/roles.ts';
const ACCOUNTS_FILE = 'docs/demo-accounts.md';

function parseRolesTs(source: string): string[] {
  const m = /export\s+const\s+roles\s*=\s*\[([^\]]*)\]/.exec(source);
  if (!m) return [];
  return [...m[1]!.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]!);
}

interface ParsedAccountsDoc {
  accounts: DiscoveredAccount[];
  password?: string;
  loginPath?: string;
}

function parseAccountsMd(source: string): ParsedAccountsDoc {
  const password = /Password for every account[^`]*`([^`]+)`/i.exec(source)?.[1];
  const loginPath = /Sign in at\s+`([^`]+)`/i.exec(source)?.[1];

  // First markdown table whose header is | Role | Email | ... — the
  // extra-employees table (Email | Name | Role) is intentionally skipped.
  const accounts: DiscoveredAccount[] = [];
  const lines = source.split('\n');
  let inTable = false;
  for (const line of lines) {
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (!line.trimStart().startsWith('|') || cells.length < 2) {
      inTable = false;
      continue;
    }
    if (!inTable) {
      if (/^role/i.test(cells[0]!) && /^email/i.test(cells[1]!)) inTable = true;
      continue;
    }
    if (/^[-: ]+$/.test(cells[0]!)) continue; // separator row
    const role = cells[0]!.replaceAll('`', '').trim();
    const email = cells[1]!.replaceAll('`', '').trim();
    if (email.includes('@')) accounts.push({ role, email });
  }
  return { accounts, password, loginPath };
}

/** Read System A and assemble a Discovery, or undefined if sources absent. */
export function discoverFromSystemA(repoAPath: string): Discovery | undefined {
  let rolesSrc: string;
  let accountsSrc: string;
  try {
    rolesSrc = readFileSync(join(repoAPath, ROLES_FILE), 'utf8');
    accountsSrc = readFileSync(join(repoAPath, ACCOUNTS_FILE), 'utf8');
  } catch {
    return undefined;
  }

  const roles = parseRolesTs(rolesSrc);
  const { accounts, password, loginPath } = parseAccountsMd(accountsSrc);
  if (roles.length === 0 || accounts.length === 0 || !password) return undefined;

  const warnings: string[] = [];
  const accountRoles = new Set(accounts.map((a) => a.role));
  for (const r of roles) {
    if (!accountRoles.has(r)) {
      warnings.push(`role "${r}" has no demo account in ${ACCOUNTS_FILE} — no recipe generated`);
    }
  }
  for (const a of accounts) {
    if (!roles.includes(a.role)) {
      warnings.push(`demo account "${a.email}" has role "${a.role}" not present in ${ROLES_FILE}`);
    }
  }

  return {
    roles,
    accounts,
    password,
    loginPath: loginPath ?? '/auth/login',
    warnings,
  };
}

/**
 * Build one System B auth recipe (lib/validation/auth-recipe.ts format)
 * for a discovered account. Locator names follow the System A template's
 * login form (LoginPage POM). Demo credentials are written inline: they
 * are already plaintext in System A's docs/demo-accounts.md, so this adds
 * no new exposure — but they are for local/dev targets only.
 */
export function buildAuthRecipeYaml(
  account: DiscoveredAccount,
  discovery: Discovery,
  project: string,
  baseUrl: string,
): string {
  const loginUrl = new URL(discovery.loginPath, baseUrl).toString();
  return stringify({
    id: `${project}-${account.role}`,
    loginUrl,
    fields: {
      username: {
        locator: { kind: 'role', role: 'textbox', name: 'Email' },
        value: account.email,
      },
      password: {
        locator: { kind: 'role', role: 'textbox', name: 'Password' },
        value: discovery.password,
      },
      extras: [],
    },
    submit: {
      locator: { kind: 'role', role: 'button', name: 'Sign in' },
    },
    postLogin: { waitFor: [] },
    expectsCaptcha: false,
  });
}

export interface WrittenRecipe {
  role: string;
  /** Path relative to System B's repo root (as referenced in the input YAML). */
  relPath: string;
}

/** Recipes that discovery would generate (used by --dry-run and writeAuthRecipes). */
export function plannedRecipes(discovery: Discovery, project: string): WrittenRecipe[] {
  return discovery.accounts
    .filter((a) => discovery.roles.includes(a.role))
    .map((a) => ({ role: a.role, relPath: `inputs/auth/${project}-${a.role}.yaml` }));
}

/**
 * Write generated recipes into System B's `inputs/auth/` (its documented
 * input mechanism — same as inputs/projects/). Connector-generated
 * recipes are overwritten on re-run; recipes the user placed there under
 * a different name are never touched.
 */
export function writeAuthRecipes(
  config: ConnectorConfig,
  discovery: Discovery,
  project: string,
  baseUrl: string,
): WrittenRecipe[] {
  const authDir = join(config.systemB.repoPath, 'inputs', 'auth');
  mkdirSync(authDir, { recursive: true });
  const accountByRole = new Map(discovery.accounts.map((a) => [a.role, a]));
  const written = plannedRecipes(discovery, project);
  for (const recipe of written) {
    writeFileSync(
      join(config.systemB.repoPath, recipe.relPath),
      buildAuthRecipeYaml(accountByRole.get(recipe.role)!, discovery, project, baseUrl),
      'utf8',
    );
  }
  return written;
}

/** Roles list for the input YAML: every discovered role, recipe attached where an account exists. */
export function rolesFromDiscovery(discovery: Discovery, recipes: WrittenRecipe[]): Role[] {
  const recipeByRole = new Map(recipes.map((r) => [r.role, r.relPath]));
  return discovery.roles.map((name) => {
    const recipe = recipeByRole.get(name);
    return recipe ? { name, authRecipe: recipe } : { name };
  });
}

/** True when the demo credentials are being pointed at a non-local target. */
export function isNonLocalTarget(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return !(host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local'));
  } catch {
    return true;
  }
}

export function discoveryExistsIn(repoAPath: string): boolean {
  return existsSync(join(repoAPath, ROLES_FILE)) && existsSync(join(repoAPath, ACCOUNTS_FILE));
}
