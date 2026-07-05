# REQ-001 — SDLC ↔ AI-Test Connector

> Format follows the `docs/requirements/REQ-*.md` convention of the SDLC
> template so this can be dropped into a `/ba` → `/planning` flow if Sang
> prefers to run the connector build through the SDLC pipeline itself.

## Summary

A standalone CLI connector that bridges the Web Application SDLC Template
(System A) and the AI Automation Framework (System B): it generates B's
test-workflow input from A's deployed app, runs B, parses B's report, and —
behind a human confirmation gate — writes failures back into A's `docs/` as
bugs and backlog candidates, closing the build→verify loop.

## Business value

- Removes the manual bridge between "sprint deployed" and "system-tested":
  today a human writes input YAML, runs the tool, reads reports, and
  retypes findings into docs.
- Creates the first end-to-end AI-SDLC closed loop demoable to leadership:
  one command from deployed app to proposed next-sprint backlog items.
- Keeps both existing systems untouched and independently usable.

## Actors

- **Engineer (Sang/EET)** — runs the connector after a sprint deploy.
- **Test lead** — continues using System B's review UI; unaffected.
- **BA/PO** — triages auto-proposed backlog candidates in the next
  `/planning` run in System A.

## Functional requirements

| ID | Requirement | Priority | AC ref |
|---|---|---|---|
| FR-1 | One-command chain: `run --url <u> --project <p>` executes input-gen → System B workflow → collect → propose write-back | Must | AC-1 |
| FR-2 | Input generation produces a System-B-valid `inputs/projects/{p}.yaml` (project, baseUrl, roles w/ authRecipe paths, crawl & generation defaults from connector config) | Must | AC-2 |
| FR-3 | System B invoked as subprocess via its documented command; stdout/stderr streamed live | Must | AC-3 |
| FR-4 | Newest JSON report for the run located under System B `reports/`; parsed into normalized model (totals + per-failure: scenario id, page, role, error) | Must | AC-4 |
| FR-5 | Failures mapped to `BUG-{n}.md` in System A's docs format; numbering = max existing + 1; each bug embeds source scenario id | Must | AC-5 |
| FR-6 | Confirmation gate before any write into System A; `--yes` bypass for demo/CI | Must | AC-6 |
| FR-7 | Backlog candidates appended (append-only) to `docs/sprints/backlog.md` | Must | AC-5 |
| FR-8 | Idempotent collection: same report re-run creates no duplicate bugs (match on embedded scenario id) | Should | AC-7 |
| FR-9 | Stage subcommands `input-only`, `collect-only` for partial runs | Should | — |
| FR-10 | Run summary JSON with per-stage timings written per run | Should | AC-8 |

## Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Zero modification of System A / System B code or file formats |
| NFR-2 | Preflight validation of both repo paths + runnability, failing fast with actionable messages |
| NFR-3 | Demo-grade staged console output (banners per stage, colors, human-gate prompt) |
| NFR-4 | TypeScript/Node 20+, minimal dependencies, no services/daemons |
| NFR-5 | Unit/integration tests run against captured fixtures only, never live systems |

## Acceptance criteria

- **AC-1** Full chain runs end-to-end with both repos configured, no manual file edits.
- **AC-2** Generated input YAML accepted by System B unmodified.
- **AC-3** System B output visibly streams during the run.
- **AC-4** Report totals and failure details correctly reflect a real run (verified against a captured report fixture).
- **AC-5** Proposed BUG files match System A docs conventions and correct numbering; backlog entries appended without altering existing content.
- **AC-6** No write into System A occurs before confirmation (or `--yes`).
- **AC-7** Re-collection of the same report yields zero new files.
- **AC-8** Run summary JSON present with stage timings.

## Out of scope

Deploying the app; modifying either system; replacing System B's review UI;
scheduling/multi-project orchestration; dashboards (a later iteration can
feed summaries into the existing usage-dashboard work).

## Dependencies & assumptions

- Both repos checked out locally; absolute paths supplied in connector config.
- Auth recipes for target app roles already exist in System B format.
- System B report JSON schema captured from a real run before parser work
  (open question OQ-1 in PROBLEM_STATEMENT.md).
- System A `docs/bugs/` numbering scheme confirmed from template examples
  (OQ-4).

## Traceability

PS: `PROBLEM_STATEMENT.md` (this connector)
→ REQ-001 (this file)
→ US/TASK breakdown: to be generated via `/ba` + `/planning` if run through
the SDLC pipeline, or implemented directly per PROBLEM_STATEMENT.md §10
implementation order.
