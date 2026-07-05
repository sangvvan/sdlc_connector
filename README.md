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
- Auth recipes (`inputs/auth/*.yaml`) already prepared in System B's format
  — the connector references them by path, it never creates credentials

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
roles:
  - name: admin
    authRecipe: inputs/auth/admin.yaml  # relative to System B repo
crawl:          # passed through verbatim into the generated input YAML
  maxPages: 50
  maxDepth: 3
generation: {}  # passed through verbatim
summaryDir: runs
```

Everything environment-specific lives here; CLI flags carry only per-run
values (`--url`, `--project`, `--yes`).

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

## Assumptions about System A / System B

Documented per PROBLEM_STATEMENT §7 — verify before pointing at new
versions of either repo:

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
3. **Role is per-report, not per-scenario.** It is parsed from the
   report's `app` field (`"project:x role:y"`). If absent, bugs show
   `Role: n/a` and the parser emits a warning.
4. **Report files live at the top level of `reports/`** as `*.json`;
   subdirectories (`reports/evidence/`, `reports/test-plans/`) are
   ignored when locating the newest report.
5. **Exit-code semantics (OQ-2)**: System B's exit code is not trusted to
   distinguish "tests failed" from "crashed". Instead: if a new report
   file appeared after the workflow started, the run counts as successful
   (failures are the payload); if none appeared, it's an infrastructure
   error and the chain stops.
6. **Input YAML shape** (`project`, `baseUrl`, `roles[].name`,
   `roles[].authRecipe`, `crawl`, `generation`) follows System B's
   documented `inputs/projects/{project}.yaml` contract. The `crawl` and
   `generation` blocks are passed through from connector config verbatim,
   so any additional keys System B accepts can be configured without code
   changes.
7. **System A bug format (OQ-4)**: no `BUG-*.md` examples existed in the
   template at development time, so bugs use the minimal structure from
   PROBLEM_STATEMENT §7 (title, severity, steps, expected/actual,
   source line). Numbering is treated as global, not per-sprint.
8. **`docs/bugs/` and `docs/sprints/` must already exist** in System A
   (preflight verifies); `backlog.md` itself is created with a header if
   missing.

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
