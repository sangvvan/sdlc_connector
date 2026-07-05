# PROBLEM_STATEMENT.md — SDLC ↔ AI-Test Connector

## 1. Context

Two independent, working systems exist today:

**System A — Web Application SDLC Template** (`web-automation-develop-template`)
An AI-agent-driven template for building web apps. Claude Code runs the
thinking phases (`/ps` → `/ba` → `/planning` → `/design`), Codex CLI runs
implementation/QA/DevOps. Stack: Remix + TypeScript + Tailwind + PostgreSQL +
Playwright + Vitest. All project knowledge lives as Markdown under `docs/`
(requirements, user-stories, tasks, sprints, bugs, traceability). Quality
gates are npm scripts (`typecheck`, `lint`, `test`, `build`, `test:e2e`)
enforced in CI.

**System B — AI Automation Framework** (`ai-automation-framework`)
An AI-assisted system-testing tool for deployed web applications. Given an
input YAML (`inputs/projects/{project}.yaml` with `baseUrl`, `roles`,
`crawl`, `generation` settings), the command
`npm run ai-test -- workflow --input <file>` authenticates each role, crawls
a sitemap, generates YAML test cases under `tests/generated/{project}/{role}/`,
runs the suite, and writes JSON/HTML reports under `reports/`. A Remix review
UI lets test leads approve/reject/promote scenarios.

Both run standalone. They have never been connected. They live in separate
repositories and must remain independently usable.

## 2. Problem statement

> When System A finishes a sprint and the app is deployed, a human must
> manually: write System B's input YAML, run the workflow, read the report,
> and manually create bug/backlog entries back in System A's `docs/`. This
> manual bridge is slow, error-prone, and breaks the closed loop between
> "build" and "verify". We need a **connector module** — a third, separate
> component — that automates this handoff in both directions without
> modifying either system.

## 3. Goals

1. **Forward handoff (A → B)**: given a deployed app URL and role
   credentials, generate a valid System B input YAML
   (`inputs/projects/{project}.yaml`) and invoke
   `npm run ai-test -- workflow --input <file>` automatically.
2. **Result collection (B)**: locate and parse the JSON report(s) System B
   writes under `reports/` for the run just executed.
3. **Backward handoff (B → A)**: convert test failures from the report into
   `docs/bugs/BUG-{n}.md` files in System A's format, and append candidate
   entries to `docs/sprints/backlog.md` — so the next sprint's `/planning`
   in System A can pick them up. This closes the loop.
4. **Human gate before write-back**: never write bugs/backlog into System A
   automatically without a confirmation step. The connector presents a
   summary (X failures → Y proposed bug files) and waits for approval
   (interactive prompt, or `--yes` flag for demo/CI).
5. **One-command demo**: a single entrypoint that runs the whole chain
   (generate input → run tests → collect results → propose write-back) with
   clear, presentable console output — this is the "demo cho sếp" command.

## 4. Non-goals

- Modifying System A or System B source code, commands, or file formats —
  the connector adapts to them, not the other way around.
- Deploying the app (System A's DevOps phase already handles deploy; the
  connector receives a URL that is already live).
- Replacing System B's review UI — approve/reject/promote of scenarios
  stays in System B. The connector only consumes final run reports.
- Multi-project orchestration, scheduling, dashboards — v1 is one project,
  one run, on demand.

## 5. Functional requirements

| # | Requirement | Priority |
|---|---|---|
| F1 | `connect run --url <deployed-url> --project <name>` executes the full chain end-to-end | Must |
| F2 | Generate System B input YAML with `project`, `baseUrl`, `roles` (from a connector config file holding auth recipe paths), and sane `crawl`/`generation` defaults, overridable via config | Must |
| F3 | Invoke System B via `npm run ai-test -- workflow --input <file>` as a subprocess, streaming its output live to the console (demo visibility) | Must |
| F4 | Detect System B's exit status and locate the newest JSON report for this run under System B's `reports/` directory | Must |
| F5 | Parse the JSON report into a normalized result model: total / passed / failed / skipped, and per-failure details (scenario, page, role, error) | Must |
| F6 | Map each failure to a proposed `BUG-{n}.md` using System A's bug format; number continues from existing files in `docs/bugs/` | Must |
| F7 | Present a write-back summary and require confirmation before touching System A's `docs/` (`--yes` to skip prompt) | Must |
| F8 | Append approved items as candidates to `docs/sprints/backlog.md` (append-only; never rewrite existing content) | Must |
| F9 | Write a connector run summary (JSON) with timings per stage, for the demo talk-track and later metrics | Should |
| F10 | `connect input-only` / `connect collect-only` subcommands to run stages independently (debugging, partial demos) | Should |
| F11 | Idempotency: re-running collect on the same report must not duplicate BUG files (skip failures already mapped, matched by scenario id) | Should |

## 6. Non-functional requirements

- **Zero intrusion**: the connector holds paths to both repos in its own
  config; it never requires code changes in either repo. If either repo is
  missing/misconfigured, fail with a clear preflight error before doing
  anything.
- **Demo-grade output**: staged, colorized console output with clear step
  banners (this will be shown live to leadership).
- **Fail loud, not silent**: any stage failure stops the chain with a
  readable error; partial results are still reported.
- **Portable**: Node.js (TypeScript) to match both repos' ecosystem; no
  extra system dependencies beyond what the two repos already require.

## 7. Constraints & assumptions

- System B's report JSON schema is treated as an external contract: the
  connector must read a real report file during development and code
  against the actual shape (do not invent fields). If the schema is
  ambiguous, prefer defensive parsing with explicit warnings.
- Auth recipes (`inputs/auth/*.yaml`) are prepared manually once per
  project in System B's format; the connector references them by path, it
  does not create credentials.
- System A's bug format: follow the existing `docs/bugs/BUG-*.md` examples
  in the template repo; if none exist yet, use the minimal structure
  consistent with the template's docs conventions (title, severity, steps,
  expected/actual, source: ai-test run id).
- Both repos are checked out locally side by side; connector config points
  at their absolute paths.

## 8. Acceptance criteria

- [ ] With both repos configured, `connect run --url <url> --project demo`
      runs A→B→collect→propose end-to-end with no manual file editing.
- [ ] The generated input YAML is accepted by System B without modification.
- [ ] System B's console output is visible live during the run.
- [ ] After a run with failures, the connector proposes BUG files whose
      content matches System A's docs conventions, numbered correctly.
- [ ] Nothing is written into System A's `docs/` before explicit
      confirmation (or `--yes`).
- [ ] Re-running collection on the same report creates zero duplicate bugs.
- [ ] A run summary JSON exists with per-stage timings.
- [ ] The full demo path works with `--yes` in one command for a live demo.

## 9. Open questions (resolve during Phase 1 of implementation)

1. Exact JSON report schema and file naming under System B `reports/` —
   inspect a real report before writing the parser.
2. Does System B's workflow exit non-zero when tests fail, or only on
   infrastructure errors? The connector must distinguish "ran, some tests
   failed" (normal) from "could not run" (error).
3. Where System A records the deployed URL after DevOps phase (if anywhere)
   — if it exists in a predictable file, the `--url` flag can become
   optional later.
4. BUG numbering: confirm whether `docs/bugs/` numbering is global or
   per-sprint in the template.

## 10. Suggested implementation order

1. **Preflight + config** — connector config schema, validation that both
   repo paths exist and expected commands are runnable.
2. **Forward handoff** — input YAML generation + subprocess invocation with
   live streaming. Verify against a real System B run on a fixture app.
3. **Report parsing** — read a real report, build the normalized model +
   defensive parser with tests using that real file as a fixture.
4. **Write-back with human gate** — BUG mapping, numbering, backlog append,
   confirmation flow, idempotency.
5. **Demo polish** — banners, colors, `--yes`, run summary JSON.

Each step is independently testable; do not start a later step before the
earlier one works against the real repos.
