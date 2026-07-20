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

## Setup — clone đúng MỘT repo

```bash
git clone https://github.com/sangvvan/sdlc_connector && cd sdlc_connector
npm install
cp connector.config.example.yaml connector.config.yaml   # defaults chạy được luôn
```

That's it. The other two repos need no manual cloning:

- **System B** (`ai-automation-framework`): auto-cloned to
  `systemB.repoPath` from `systemB.repoUrl` + `npm install`, the first
  time any chain runs.
- **Template** (`web-automation-develop-template`): `web.templateRepo`
  is a git URL — cloned fresh per project by the factory.

Prerequisites on the machine (tools, not repos): Node.js 20+, git,
Docker running (local deploys), Claude/Codex CLI logged in (cloud build
providers), `gh` logged in (GitHub repo creation), and LM Studio/Ollama
or a cloud provider for System B's AI test generation (without one it
falls back to smoke tests).

> **Cài Node 20 trên Ubuntu**: ĐỪNG dùng `apt install npm` (gói distro
> cổ và vỡ dependency). Dùng nvm:
> ```bash
> curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
> source ~/.bashrc && nvm install 20
> ```
> (hoặc NodeSource: `curl -fsSL https://deb.nodesource.com/setup_20.x |
> sudo -E bash - && sudo apt install -y nodejs` — gói này có npm sẵn.)

### LM Studio (chạy AI không tốn token cloud)

Một block config duy nhất phục vụ cả hai hệ thống:

```yaml
localLLM:
  baseUrl: http://127.0.0.1:1234/v1
  model: gemma-4-26b-a4b-it-mlx
```

- **System A phases** (provider `opencode`): khi tạo project, connector
  tự chạy `scripts/setup_opencode.sh` của project với đúng
  baseUrl/model trên — không phải setup tay từng project. Provider
  `opencode-ollama` dùng `setup_opencode_ollama.sh` nếu có.
- **System B (AI test)**: `configs/ai-provider.yaml` trong
  ai-automation-framework đã đặt `defaultProvider: lmstudio` với cùng
  model.

Trên LM Studio: load model → bật **Start Server** (port 1234) →
Context Length ≥ 8k. LM Studio tắt = job báo warning rõ ràng (không
treo, không fail ngầm).

For projects built from the System A template, roles and auth recipes
are discovered automatically (see below). For other projects: auth
recipes prepared in System B's format, referenced from `roles` in the
connector config.

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

## `connect pipeline` — one config, one command, the whole lifecycle

For a brand-new project the demo above still assumes someone already ran
System A's phases and deployed. `pipeline` removes that too — everything
is declared once in the `pipeline:` block of `connector.config.yaml`:

```yaml
pipeline:
  project: demo
  requirementFile: requirement.md            # what to build
  build:
    requirementDoc: docs/requirements/PS-001.md   # written into System A's repo
    commands:
      - ["scripts/legacy/run.sh", "/ps", "Generate versioned requirements (REQ-*.md) from {requirementDoc}", "--provider=claude"]
      - ["scripts/legacy/run.sh", "/feature", "all", "--provider=claude"]
  deploy:
    command: ["scripts/deploy.sh", "local"]
    url: http://localhost:3000
    healthTimeoutSec: 180
```

```bash
npx tsx src/cli.ts pipeline --yes            # or omit --yes to keep the gate
npx tsx src/cli.ts pipeline --skip-build     # app code exists, just deploy+test
npx tsx src/cli.ts pipeline --skip-deploy    # app already running
npx tsx src/cli.ts pipeline --requirement docs/req-v2.md   # per-run override
```

Stages (each visible as a `█ GIAI ĐOẠN x/3` banner):

1. **BUILD** — the connector writes the requirement into
   `build.requirementDoc` (template convention:
   `docs/requirements/PS-001.md`), then runs `build.commands` in order —
   by default System A's own `run.sh /ps …` (problem statement →
   `REQ-*.md`) followed by `run.sh /feature all` (BA → Planning → Design
   → Implementation → QA → DevOps for every requirement). The connector
   adds nothing of its own here — it only invokes what System A
   documents. Important: `run.sh` accepts only short prompts/IDs as
   arguments — passing a whole document as argv breaks its internal
   parsing, which is why the doc is written to a file and referenced by
   path via the `{requirementDoc}` token.
2. **DEPLOY** — runs System A's deploy script, then polls `deploy.url`
   until the app answers (any HTTP status < 500) or `healthTimeoutSec`
   expires.
3. **TEST + WRITE-BACK** — the standard BƯỚC 0-4 chain (discovery →
   System B run → collect → human gate → bugs/backlog into System A).

Notes:

- The BUILD stage requires System A's AI providers (Claude/Codex CLIs)
  to be installed and authenticated on this machine — that is System A's
  own prerequisite, not the connector's.
- `--yes` bypasses only the connector's write-back gate; any interactive
  gates inside System A's own pipeline remain System A's behavior.
- A failed build/deploy stops the chain (fail loud); `--skip-build` /
  `--skip-deploy` let you resume from the middle.

## `connect new` — Project Factory trên terminal (wizard)

The CLI twin of the web form — same inputs, same automation, no browser:

```bash
npx tsx src/cli.ts new
```

It asks one question per field (Enter accepts the `[default]`): project
name, requirement file, tech stack, AI provider, deploy target, app URL,
optional GitHub repo, and the skip-build / skip-deploy toggles. After a
summary + confirmation it runs the exact same kickoff job as the web UI
(clone template → git init/link → npm install → full pipeline → push),
streaming the job log live in the terminal and finishing with the result
card (repo path, app URL, totals, bugs written, push status). Projects
created here also show up in the `connect web` list — both modes share
the same workspace and job state.

## `connect web` — Project Factory UI (localhost v1)

A one-page web UI over `pipeline` for starting projects without touching
a terminal or YAML:

```yaml
web:
  port: 4000
  templateRepo: /abs/path/web-automation-develop-template   # or a git URL
  workspaceDir: projects
```

```bash
npx tsx src/cli.ts web        # → http://127.0.0.1:4000
```

Form: project name, problem statement (paste or upload .md), optional
tech stack, AI provider (claude default / codex / gemini / opencode),
deploy target (local / staging / production × aws / azure / vercel),
the app URL, and an optional **GitHub repo** (existing repo → used
as-is; missing → created private via `gh repo create`, so `gh auth
login` must work on this machine). When a repo is given, the clone is
detached from the template's history (fresh `git init` + initial
commit as `sdlc-connector`), and after the pipeline finishes everything
the AI built is committed and pushed to `main`. Repo linking/push
failures are warnings in the log, never job failures. Submit and the
server:

1. clones `templateRepo` into `{workspaceDir}/{name}/` (a fresh System A
   project repo),
2. writes `{name}.requirement.md` + a generated `{name}.connector.yaml`
   (per-project pipeline config, System B + defaults inherited from the
   base config),
3. runs `connect pipeline --yes` as a background job — build → deploy →
   health check → AI test → write-back,
4. shows live logs (the same GIAI ĐOẠN/BƯỚC output) and a result card:
   repo path, app URL, pass/fail totals, BUG files written.

The project team then continues exactly as in the normal workflow —
`/planning` in the new repo sees the bugs/backlog; later runs reuse the
project's System B input (reuse mode).

Scope guardrails (v1): binds `127.0.0.1` only, single user, no auth —
it shells out to git/npm/System A scripts, so do NOT expose it publicly.
AI provider CLIs and deploy credentials must already work on this
machine. Job state survives server restarts
(`{workspaceDir}/{name}.state.json` + `.log`).

## Build mode: foundation vs full (tiết kiệm token)

Chạy trọn chuỗi AI build ngốn rất nhiều token. Mặc định project mới giờ
dùng **foundation mode**:

- **foundation** (mặc định): chỉ chạy các phase kiến thiết —
  `/ps` sinh REQ-*.md, rồi `/feature all
  --skip=implementation,local_tasks,qa,devops` sinh US/TASK/design docs
  — xong dừng (không implement, không deploy, không test). Kết quả hiện
  số REQ/US/TASK/SPRINT đã sinh. Push lên GitHub bình thường.
- **full**: chuỗi build → deploy → AI test như cũ.

Sau foundation, **team members chọn việc chạy dần** — bằng provider
local (LM Studio qua `opencode`, không tốn token cloud) hoặc bất kỳ
provider nào:

```bash
connect work <project> TASK-001                 # implement 1 task
connect work <project> REQ-002                  # full pipeline 1 requirement
connect work <project> sprint plan SPRINT-001 US-001 US-002
connect work <project> sprint start
connect work <project> /fix BUG-001             # lệnh run.sh bất kỳ
connect work <project> TASK-003 --provider=claude   # override provider
```

`work` chạy `scripts/legacy/run.sh` của chính project đó (provider mặc
định = provider chọn lúc tạo project). Khi app đã deploy được, chạy vòng
AI test: `connect pipeline --config projects/<p>.connector.yaml --yes
--skip-build`.

AI providers: `claude` / `codex` / `copilot` / `gemini` (cloud) —
`opencode` (LM Studio local) / `opencode-ollama` (Ollama local).
Local provider cần LM Studio/Ollama đang chạy và System A đã setup
opencode (`scripts/setup_opencode.sh` trong template).

## Project lifecycle: xoá, chạy lại, chạy song song

- **Xoá project** (kể cả project failed): nút 🗑 trên web UI, hoặc
  `connect rm <name>` (`--force` nếu job đang chạy). Gỡ trọn gói:
  `docker compose down -v` (container + database volume, giải phóng
  port), rồi xoá repo clone và toàn bộ metadata trong workspace. Docker
  daemon chết cũng không chặn được việc xoá files.
- **Chạy lại**: nút "▶ Chạy lại (cùng cấu hình)" trên trang detail của
  web UI — hoặc POST lại cùng tên (chỉ bị chặn khi job đang chạy).
  Repo clone và node_modules được dùng lại nên nhanh hơn lần đầu.
- **Nhiều project song song**: mỗi project được cô lập port tự động khi
  deploy local — `LOCAL_PORT` lấy từ URL app anh nhập (mỗi project chọn
  một URL/port khác nhau, vd :3000, :3010), còn postgres host port được
  cấp phát tự động (port trống đầu tiên từ 5433) và ghi vào `.env` của
  project để các lần deploy sau giữ nguyên. Connector chỉnh compose file
  **của bản clone project** (parametrize `POSTGRES_HOST_PORT`) — template
  gốc và System B không bị đụng. Database mỗi project là một Docker
  volume riêng theo tên project, không đụng nhau.

## Troubleshooting local deploys

- **Docker daemon not reachable** — start Docker Desktop or `colima
  start` before the deploy stage; verify with `docker ps`.
- **Missing SESSION_SECRET / POSTGRES_PASSWORD** — handled automatically
  for `local` targets: the connector generates `.env` from
  `.env.example` with random dev secrets. Cloud targets are on purpose
  NOT auto-filled.
- **`Bind for 127.0.0.1:5433 failed: port is already allocated`** —
  factory projects are auto-isolated now (see "Project lifecycle"), so
  this only happens when something OUTSIDE the factory holds the port
  (a previously-run template checkout, a brew postgres). Find it with
  `docker ps --filter "publish=5433"` / `lsof -nP -iTCP:5433` and stop
  it, or delete + re-run the project to get a fresh port assigned.

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
