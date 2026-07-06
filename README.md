# SDLC ↔ AI-Test Connector

A standalone CLI that closes the build→verify loop between two existing,
**unmodified** systems:

- **System A** — `web-automation-develop-template` (AI-agent SDLC template;
  Markdown docs under `docs/`)
- **System B** — `ai-automation-framework` (AI system-testing tool;
  YAML input in, JSON report out)

One command: generate System B's input from A's deployed app → run B with
live output → parse B's report → propose BUG/backlog entries back into A's
`docs/` behind a human confirmation gate.

See `PROBLEM_STATEMENT.md` (why) and `CLAUDE.md` (how) for full context.

## Setup

```bash
npm install
cp connector.config.example.yaml connector.config.yaml
# edit connector.config.yaml: absolute paths to both repos, roles, defaults
```

Prerequisites:

- Node.js 20+
- Both repos checked out locally; System B has had `npm install` run
- For projects built from the System A template: **nothing else** — roles
  and auth recipes are discovered automatically (see below). For other
  projects: auth recipes prepared in System B's format, referenced from
  `roles` in the connector config.

## Config format (`connector.config.yaml`)

```yaml
systemA:
  repoPath: /abs/path/web-automation-develop-template
  bugsDir: docs/bugs                    # default
  backlogFile: docs/sprints/backlog.md  # default
systemB:
  repoPath: /abs/path/ai-automation-framework
  inputsDir: inputs/projects            # default
  reportsDir: reports                   # default
roles: []       # optional fallback — see "Where roles come from" below
crawl:          # passed through verbatim into the generated input YAML
  maxPages: 50
  maxDepth: 3
generation: {}  # passed through verbatim
run: {}         # passed through verbatim (testLevel, browsers, nonFunctional…)
summaryDir: runs
```

Everything environment-specific lives here; CLI flags carry only per-run
values (`--url`, `--project`, `--yes`).

## Where roles come from (priority order)

The connector resolves roles/auth for the generated input YAML from three
sources, first match wins:

1. **Existing System B input** — if `inputs/projects/{project}.yaml`
   already exists in System B, it is the source of truth: everything in it
   is kept and only `baseUrl` (and `project`) are updated per run. Teams
   that hand-tuned their System B config lose nothing.
2. **Discovery from System A** (fresh template projects — zero manual
   config): the connector reads
   - `app/lib/auth/roles.ts` → the role list,
   - `docs/demo-accounts.md` → demo email per role, the shared password,
     and the login path,
   and generates one System B auth recipe per role into
   `inputs/auth/{project}-{role}.yaml` (validated against System B's
   `AuthRecipe` schema). Locators use the template login form's
   accessibility names (`Email`, `Password`, `Sign in` — the same ones
   `tests/pom/LoginPage.ts` uses). A warning is printed when these demo
   credentials are pointed at a non-localhost target.
3. **`roles` in connector config** — fallback for projects that don't
   follow the template conventions.

## The one-command demo

```bash
npx tsx src/cli.ts run --url https://app.example.com --project demo
npx tsx src/cli.ts run --url https://app.example.com --project demo --yes   # no prompts
```

The run shows four banners (BƯỚC 1–4): input generation, System B's own
output streaming live, report collection, and the write-back proposal with
the `👤 HUMAN GATE` prompt. Nothing touches System A's `docs/` before you
answer `y` (or pass `--yes`).

Partial stages for debugging:

```bash
npx tsx src/cli.ts input-only --url https://... --project demo [--dry-run]
npx tsx src/cli.ts collect-only [--report path/to/R-xxx.json] [--yes]
```

Every run writes `runs/summary-<timestamp>.json` with per-stage timings.

## Write-back behavior

- `docs/bugs/BUG-{n}.md`: created only, never overwritten. Numbering scans
  existing `BUG-*.md` and continues from max + 1.
- `docs/sprints/backlog.md`: strictly append-only; the appended block is
  marked with the connector name, date and run id.
- **Idempotency**: each BUG file embeds
  `<!-- ai-test-source: {scenarioId}|{pageUrl}|{title} -->`. Re-running
  collection on the same report (or a later report reproducing the same
  failure) skips failures whose key already exists in `docs/bugs/`.

## Testing

```bash
npm run test        # vitest — fixture-based, never calls the live systems
npm run typecheck
npm run lint
```

`fixtures/sample-report.json` is a **real** report captured from a System B
run (`R-20260530-143223-bbc6`, 44 scenarios, 25 failed) — the parser is
coded against it, not an invented schema.

## Assumptions & facts verified against System A / System B source

Documented per PROBLEM_STATEMENT §7. Items marked **[verified]** were
checked directly against both repos' source code:

1. **Report pass/fail is keyed on `validation.status`, not
   `result.status`.** In the captured report, `totals.failed = 25` matches
   the count of `validation.status == "failed"`; only 9 scenarios have
   `result.status == "failed"` (execution can pass while the
   expected-result validation fails).
2. **Scenario ids are not unique within a report.** The same id (e.g.
   `NF-USAB-001`) appears once per page, and the same id+page pair can
   even carry two different AI-generated scenarios (e.g. `EP-001` twice
   on `/` with different titles). The connector therefore uses
   `scenarioId|pageUrl|title` as the failure identity for idempotency.
3. **[verified] One report per role.** The workflow command runs each role
   as its own run and writes `{reportsDir}/json/{runId}.json` per role
   (`lib/reporter/json.ts`), plus an aggregate under
   `{reportsDir}/workflows/`. The connector collects **all** reports newer
   than the workflow start, parses each, and merges failures (a failure
   seen by several roles becomes one bug). Role is parsed from each
   report's `app` field (`"project:x role:y"`).
4. **[verified] Reports dir resolution.** System B's own
   `configs/framework.config.yaml` (`reportsDir`, default `reports`) is
   read (read-only) to find the reports dir; the connector config value is
   the fallback. `reports/json/` is scanned first, then the reports root;
   `evidence/`, `test-plans/`, `workflows/` subdirs are ignored.
5. **[verified] Exit-code semantics (OQ-2 resolved).**
   `lib/cli/commands/workflow.ts` returns 0 = all passed, 1 = ran with
   test failures, 2 = orchestration error. The connector treats 0 and 1
   as successful runs (failures are the payload). Exit 2 with reports
   present → partial results are collected with a warning; no reports at
   all → infrastructure error, chain stops.
6. **[verified] Input YAML shape** matches System B's `WorkflowInput` zod
   schema (`lib/workflow/config.ts`): `project`, `baseUrl`, `roles[].name`
   (+ optional `authRecipe` — when omitted System B auto-detects the login
   form and bootstraps a recipe), `crawl`, `generation`, `run`. The
   `crawl`/`generation`/`run` blocks are passed through from connector
   config verbatim, so any key System B accepts works without code
   changes.
7. **[verified] System A bug format (OQ-4)** follows the real
   `docs/bugs/BUG-001.md` in the template: YAML frontmatter (`id`,
   `title`, `severity`, `status`, `created_at`, `traces_to`, `owner`) +
   `# BUG-{n} - Title` + Summary/Steps/Expected/Actual/Evidence sections.
   Numbering is global (single `docs/bugs/` dir, no per-sprint scheme).
8. **[verified] `docs/sprints/backlog.md` is System A's backlog
   convention** (`.agent/skills/core/scrum.md`), though the file may not
   exist yet in a fresh template — the connector creates it with a header
   when missing, and only ever appends.
9. **[verified] Discovery sources are template conventions**:
   `app/lib/auth/roles.ts` (`export const roles = [...]`) and
   `docs/demo-accounts.md` (role→email table + shared password + "Sign in
   at `/auth/login`"). Generated recipes were validated against System B's
   real `loadAuthRecipe`/`readWorkflowInput`. If a project diverges from
   these conventions, discovery silently steps aside and the `roles`
   fallback in connector config applies. Note this consciously extends
   PROBLEM_STATEMENT §7 ("auth recipes are prepared manually"): the
   connector still creates no credentials — it transfers the demo
   credentials System A already publishes in its own docs. They are
   written inline into the generated recipes (no new exposure; they are
   already plaintext in System A) and are for local/dev targets only.

## Acceptance criteria status (PROBLEM_STATEMENT §8)

| Criterion | Verification |
|---|---|
| Full chain via `connect run` | Manual: run against both real repos (see demo command) |
| Generated input accepted by System B unmodified | `tests/inputgen.test.ts` + manual System B run |
| System B output visible live | `execa` with `stdio: inherit` — manual observation |
| Proposed BUG files match conventions, numbered correctly | `tests/bugmap.test.ts`, `tests/numbering.test.ts` |
| Nothing written before confirmation / `--yes` | Gate in `src/writeback/gate.ts`; writes happen only after approval in `src/cli.ts` |
| Re-running collection creates zero duplicates | `existingSourceKeys` tests + `collect-only` re-run manually |
| Run summary JSON with per-stage timings | `runs/summary-*.json` written every run |
| Full demo path with `--yes` in one command | Manual: `run --yes` against both real repos |

Manual steps require both real repos configured locally and a deployed
fixture app; the unit suite covers everything reachable from fixtures.
