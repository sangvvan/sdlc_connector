# CLAUDE.md — SDLC ↔ AI-Test Connector

Context for Claude Code working on this repo. Read `PROBLEM_STATEMENT.md`
first for the why; this file is the how.

## What this is

A standalone connector (third repo) that bridges two existing, unmodified
systems:

- **System A** — `web-automation-develop-template`: AI-agent SDLC template.
  Produces a deployed web app + Markdown docs under `docs/` (bugs, sprints,
  backlog, traceability).
- **System B** — `ai-automation-framework`: AI system-testing tool. Consumes
  `inputs/projects/{project}.yaml`, runs
  `npm run ai-test -- workflow --input <file>`, writes JSON/HTML reports
  under `reports/`.

The connector: generates B's input from A's deployed app → runs B → parses
B's report → proposes BUG/backlog entries back into A's `docs/` behind a
human confirmation gate.

**Golden rule: never modify System A or System B.** If something seems to
require changing them, stop and flag it — the answer is to adapt the
connector, or surface the limitation, not to patch the other repos.

## Tech stack

- **Language**: TypeScript on Node.js 20+ (matches both target repos)
- **Runtime deps (keep minimal)**: `yaml` (parse/serialize), `zod`
  (config + report validation), `execa` (subprocess with live streaming),
  `picocolors` (console output). Avoid heavier frameworks — this is a CLI,
  not a service.
- **CLI parsing**: `commander`
- **Testing**: `vitest`. Integration tests use fixture files (a real
  System B report JSON captured during development) — never call the live
  systems from unit tests.
- **Lint/format**: `eslint` + `prettier`, TypeScript `strict: true`

## Repo structure

```
.
├── PROBLEM_STATEMENT.md
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── connector.config.yaml        # user-edited: paths to repo A and B, roles, defaults
├── src/
│   ├── cli.ts                   # commander entrypoint: run / input-only / collect-only
│   ├── config.ts                # load + zod-validate connector.config.yaml
│   ├── preflight.ts             # verify both repos exist, commands runnable
│   ├── forward/
│   │   ├── inputgen.ts          # build System B input YAML
│   │   └── invoke.ts            # spawn `npm run ai-test -- workflow`, stream output
│   ├── collect/
│   │   ├── locate.ts            # find newest report for the run
│   │   ├── parse.ts             # JSON report -> normalized RunResult
│   │   └── model.ts             # RunResult / Failure types
│   ├── writeback/
│   │   ├── bugmap.ts            # Failure -> BUG-{n}.md content (System A format)
│   │   ├── backlog.ts           # append candidates to backlog.md (append-only)
│   │   ├── numbering.ts         # next BUG number from existing docs/bugs/
│   │   └── gate.ts              # summary + confirmation prompt (--yes bypass)
│   ├── report/
│   │   └── summary.ts           # connector run summary JSON (stage timings)
│   └── ui.ts                    # banners, colors, step output
├── fixtures/
│   ├── sample-report.json       # REAL report captured from System B (see below)
│   └── sample-config.yaml
└── tests/
    ├── inputgen.test.ts
    ├── parse.test.ts
    ├── bugmap.test.ts
    └── numbering.test.ts
```

## Critical implementation notes

1. **Capture a real report first.** Before writing `parse.ts`, run System B
   manually once against any URL and copy the produced JSON report into
   `fixtures/sample-report.json`. Code the parser against that real file.
   Do NOT invent a report schema. If a field you need doesn't exist,
   note it in the README under "assumptions" rather than guessing.

2. **Exit-code semantics.** Determine empirically whether System B exits
   non-zero when tests fail vs when it crashes. The connector must treat
   "ran with failures" as a successful connector run (failures are the
   payload!) and only treat infrastructure errors as connector failures.

3. **Live streaming matters.** The demo shows System B's own output
   scrolling during the run. Use `execa` with `stdio: inherit`-style
   streaming for the invoke step; capture to a buffer in parallel only if
   needed for parsing (report location comes from the filesystem, not
   stdout, so plain inherit is fine).

4. **Write-back is append-only and gated.**
   - `docs/sprints/backlog.md`: only append, never rewrite.
   - `docs/bugs/BUG-{n}.md`: only create new files, never overwrite.
   - Numbering: scan existing `BUG-*.md`, take max + 1.
   - Idempotency: embed the System B scenario id in each BUG file
     (e.g. a `source:` line); before creating, scan existing bugs for that
     id and skip duplicates.
   - Nothing is written before the confirmation gate passes.

5. **Config over flags.** Everything environment-specific (repo paths,
   auth recipe paths, crawl defaults) lives in `connector.config.yaml`.
   CLI flags carry only per-run values (`--url`, `--project`, `--yes`).

6. **Preflight before anything.** `preflight.ts` checks: both repo paths
   exist, System B has `node_modules` (or warn to run npm install), the
   report and docs directories are where config says. Fail fast with a
   message that says exactly what to fix.

## Console output style (demo-grade)

Step banners in this exact structure — the demo talk-track depends on it:

```
════════════════════════════════════════════
║ BƯỚC 1/4  Sinh input cho AI-Test từ app đã deploy
════════════════════════════════════════════
✓ inputs/projects/demo.yaml created (2 roles, maxPages 50)

════════════════════════════════════════════
║ BƯỚC 2/4  Chạy AI Automation Framework
════════════════════════════════════════════
$ npm run ai-test -- workflow --input inputs/projects/demo.yaml
[... System B live output streams here ...]

════════════════════════════════════════════
║ BƯỚC 3/4  Thu kết quả
════════════════════════════════════════════
✓ Report: reports/run-2026-xx-xx.json — 42 total, 39 passed, 3 failed

════════════════════════════════════════════
║ BƯỚC 4/4  Đề xuất ghi ngược về SDLC docs
════════════════════════════════════════════
3 failures → 3 proposed bug files (BUG-007..BUG-009) + 3 backlog candidates
👤 HUMAN GATE: ghi vào docs/? [y/N]
```

Bilingual is fine (banners Vietnamese, detail lines English) — that matches
how the team communicates.

## How to run (once implemented)

```bash
npm install
cp connector.config.example.yaml connector.config.yaml   # edit paths
npx tsx src/cli.ts run --url https://app.example.com --project demo
npx tsx src/cli.ts run --url ... --project demo --yes    # demo mode, no prompts
```

## How to test

```bash
npm run test        # vitest, fixture-based, no live systems
npm run typecheck
npm run lint
```

Every acceptance criterion in PROBLEM_STATEMENT.md §8 needs a test or a
documented manual verification step in the README before it's "done".

## Definition of done

- All §8 acceptance criteria checked off
- `fixtures/sample-report.json` is a real captured report, not synthetic
- README documents: setup, config format, the one-command demo, and every
  assumption made about System A/B file formats
- The full demo path (`run --yes`) executed successfully at least once
  against both real repos with a real deployed fixture app
