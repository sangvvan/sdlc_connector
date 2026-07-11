#!/usr/bin/env tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, type ConnectorConfig } from './config.js';
import { preflight, hasErrors } from './preflight.js';
import { applyInputPlan, buildInputYaml, planInput, type AppliedInput } from './forward/inputgen.js';
import { isNonLocalTarget, plannedRecipes, rolesFromDiscovery } from './discover/discover.js';
import { invokeSystemB } from './forward/invoke.js';
import { locateNewReports, locateNewestReport, resolveReportsDir } from './collect/locate.js';
import { parseReport } from './collect/parse.js';
import type { Failure, RunResult } from './collect/model.js';
import { buildBugFile, type ProposedBug } from './writeback/bugmap.js';
import { nextBugNumber, existingSourceKeys } from './writeback/numbering.js';
import { buildBacklogAppendix, appendToBacklog } from './writeback/backlog.js';
import { confirmWriteback } from './writeback/gate.js';
import { RunSummary } from './report/summary.js';
import { ensureDevEnv, runStageCommand, substituteTokens, waitForUrl } from './pipeline/pipeline.js';
import { banner, phase, ok, warn, fail, cmd } from './ui.js';

function loadConfigOrDie(configPath: string): ConnectorConfig {
  try {
    return loadConfig(configPath);
  } catch (e) {
    fail((e as Error).message);
    process.exit(1);
  }
}

function runPreflightOrDie(config: ConnectorConfig): void {
  const issues = preflight(config);
  for (const issue of issues) {
    if (issue.level === 'error') fail(issue.message);
    else warn(issue.message);
  }
  if (hasErrors(issues)) {
    fail('Preflight failed — fix the issues above, nothing was executed.');
    process.exit(1);
  }
}

/**
 * Merge failures from several reports (one per role) into one proposal
 * set. Failures sharing a sourceKey across roles collapse into one bug —
 * the same broken scenario seen by two roles is one defect, not two.
 */
function mergeFailures(runs: RunResult[]): Failure[] {
  const seen = new Set<string>();
  const merged: Failure[] = [];
  for (const run of runs) {
    for (const f of run.failures) {
      if (seen.has(f.sourceKey)) continue;
      seen.add(f.sourceKey);
      merged.push(f);
    }
  }
  return merged;
}

/** Print how the input was assembled (BƯỚC 0 shows only when discovery ran). */
function describeInput(applied: AppliedInput, config: ConnectorConfig, baseUrl: string): void {
  const { plan } = applied;
  if (plan.mode === 'reuse') {
    ok(
      `Reusing existing ${plan.path} (${applied.roleCount} roles kept, baseUrl → ${baseUrl})`,
    );
    return;
  }
  if (plan.mode === 'discovered') {
    const d = plan.discovery!;
    ok(`Discovered ${d.roles.length} roles from System A (app/lib/auth/roles.ts)`);
    ok(
      `${applied.recipes.length} auth recipes generated from docs/demo-accounts.md → inputs/auth/`,
    );
    for (const w of d.warnings) warn(`discovery: ${w}`);
    if (isNonLocalTarget(baseUrl)) {
      warn(
        `demo credentials from docs/demo-accounts.md are being used against non-local target ${baseUrl} — they are meant for local/dev only`,
      );
    }
    return;
  }
  ok(`Roles from connector.config.yaml (${config.roles.length} roles)`);
}

function reportLine(run: RunResult): void {
  ok(
    `Report: ${run.reportPath} — ${run.totals.total} total, ` +
      `${run.totals.passed} passed, ${run.totals.failed} failed`,
  );
  for (const w of run.warnings) warn(`parser: ${w}`);
}

interface WritebackOutcome {
  written: ProposedBug[];
  skippedDuplicates: number;
  approved: boolean;
}

/**
 * Propose BUG files + backlog candidates for the failures, behind the
 * human gate. Idempotent: failures whose source key already exists in
 * docs/bugs/ are skipped (F11). Nothing is written before approval.
 */
async function proposeAndWriteback(
  config: ConnectorConfig,
  failures: Failure[],
  runLabel: string,
  yes: boolean,
): Promise<WritebackOutcome> {
  const bugsDir = join(config.systemA.repoPath, config.systemA.bugsDir);
  const known = existingSourceKeys(bugsDir);

  const fresh = failures.filter((f) => !known.has(f.sourceKey));
  const skippedDuplicates = failures.length - fresh.length;

  let n = nextBugNumber(bugsDir);
  const proposed = fresh.map((f) => buildBugFile(f, n++));

  const approved = await confirmWriteback(proposed, skippedDuplicates, yes);
  if (!approved || proposed.length === 0) {
    return { written: [], skippedDuplicates, approved };
  }

  // Create-only: never overwrite an existing BUG file (critical note 4).
  const written: ProposedBug[] = [];
  for (const bug of proposed) {
    const path = join(bugsDir, bug.fileName);
    if (existsSync(path)) {
      warn(`${bug.fileName} already exists — refusing to overwrite, skipped`);
      continue;
    }
    writeFileSync(path, bug.content, { encoding: 'utf8', flag: 'wx' });
    written.push(bug);
  }
  if (written.length > 0) {
    const backlogFile = join(config.systemA.repoPath, config.systemA.backlogFile);
    appendToBacklog(backlogFile, buildBacklogAppendix(written, runLabel));
    ok(`${written.length} BUG files created in ${config.systemA.bugsDir}/`);
    ok(`${written.length} candidates appended to ${config.systemA.backlogFile}`);
  }
  return { written, skippedDuplicates, approved };
}

/**
 * The connector's core chain (BƯỚC 0-4): input gen (+discovery) →
 * System B workflow → collect → gated write-back → summary.
 * Shared by `run` and the test stage of `pipeline`.
 */
async function runChain(
  config: ConnectorConfig,
  opts: { url: string; project: string; yes: boolean },
): Promise<void> {
  const summary = new RunSummary(opts.project, opts.url);
  const runStartedAt = new Date();

  try {
    const applied = await summary.time('input-gen', () =>
      applyInputPlan(config, { project: opts.project, baseUrl: opts.url }),
    );
    if (applied.plan.mode === 'discovered') {
      banner(0, 4, 'Tự động lấy roles & accounts từ SDLC docs (System A)');
      describeInput(applied, config, opts.url);
    }

    banner(1, 4, 'Sinh input cho AI-Test từ app đã deploy');
    if (applied.plan.mode !== 'discovered') describeInput(applied, config, opts.url);
    const inputPath = applied.plan.path;
    const crawl = config.crawl as { maxPages?: number };
    ok(
      `${join(config.systemB.inputsDir, `${opts.project}.yaml`)} created ` +
        `(${applied.roleCount} roles, maxPages ${crawl.maxPages ?? '?'})`,
    );

    banner(2, 4, 'Chạy AI Automation Framework');
    cmd('npm run ai-test -- workflow --input ' + join(config.systemB.inputsDir, `${opts.project}.yaml`));
    const invoke = await summary.time('system-b-workflow', () => invokeSystemB(config, inputPath));

    banner(3, 4, 'Thu kết quả');
    const runs = await summary.time('collect', () => {
      // System B exit codes (lib/cli/commands/workflow.ts): 0 = all
      // passed, 1 = ran with test failures (normal — failures are the
      // payload), 2 = orchestration error. One report per role is
      // written to {reportsDir}/json/{runId}.json.
      const reportPaths = locateNewReports(config, runStartedAt);
      if (reportPaths.length === 0) {
        throw new Error(
          `System B exited with code ${invoke.exitCode} and no new report appeared under ` +
            `${resolveReportsDir(config)} — infrastructure error, nothing to collect.`,
        );
      }
      if (invoke.exitCode === 2) {
        warn('System B reported an orchestration error (exit 2) — collecting partial results.');
      }
      return reportPaths.map((p) => parseReport(p));
    });
    for (const run of runs) reportLine(run);

    banner(4, 4, 'Đề xuất ghi ngược về SDLC docs');
    const failures = mergeFailures(runs);
    const runLabel = runs.map((r) => r.runId).join(', ');
    const outcome = await summary.time('write-back', () =>
      proposeAndWriteback(config, failures, runLabel, opts.yes),
    );
    if (!outcome.approved && failures.length > 0) {
      console.log(pc.dim('Write-back declined — System A docs untouched.'));
    }

    const summaryPath = summary.write(config.summaryDir, {
      runIds: runs.map((r) => r.runId),
      totals: runs.map((r) => r.totals),
      bugsWritten: outcome.written.map((b) => b.fileName),
      skippedDuplicates: outcome.skippedDuplicates,
    });
    console.log('');
    ok(`Run summary: ${summaryPath}`);
  } catch (e) {
    fail((e as Error).message);
    const summaryPath = summary.write(config.summaryDir, { error: (e as Error).message });
    console.log(pc.dim(`Partial run summary: ${summaryPath}`));
    process.exit(1);
  }
}

const program = new Command();
program
  .name('connect')
  .description('SDLC ↔ AI-Test connector: A → B → collect → write-back proposal')
  .option('-c, --config <path>', 'connector config file', 'connector.config.yaml');

program
  .command('run')
  .description('Full chain: generate input → run System B → collect → propose write-back')
  .requiredOption('--url <url>', 'deployed app base URL')
  .requiredOption('--project <name>', 'System B project name')
  .option('--yes', 'skip the human confirmation gate (demo/CI)', false)
  .action(async (opts: { url: string; project: string; yes: boolean }) => {
    const config = loadConfigOrDie(program.opts().config);
    runPreflightOrDie(config);
    await runChain(config, opts);
  });

program
  .command('pipeline')
  .description(
    'Full lifecycle from ONE config: requirement → System A agents build → deploy → AI test → write-back',
  )
  .option('--requirement <file>', 'requirement file (overrides pipeline.requirementFile)')
  .option('--skip-build', 'skip the System A agents build stage', false)
  .option('--skip-deploy', 'skip the deploy stage (app already running)', false)
  .option('--yes', 'skip the human confirmation gate (demo/CI)', false)
  .action(
    async (opts: { requirement?: string; skipBuild: boolean; skipDeploy: boolean; yes: boolean }) => {
      const config = loadConfigOrDie(program.opts().config);
      const p = config.pipeline;
      if (!p) {
        fail(
          'No `pipeline:` block in connector.config.yaml — add project, build.command, ' +
            'deploy.command and deploy.url (see connector.config.example.yaml).',
        );
        process.exit(1);
      }
      runPreflightOrDie(config);
      const repoA = config.systemA.repoPath;

      try {
        // ── GIAI ĐOẠN 1: System A agents build from the requirement ──
        if (!opts.skipBuild && p.build) {
          const reqFile = opts.requirement ?? p.requirementFile;
          if (!reqFile) {
            throw new Error(
              'Build stage needs a requirement: pass --requirement <file> or set pipeline.requirementFile.',
            );
          }
          const reqFileAbs = resolve(reqFile);
          const requirement = readFileSync(reqFileAbs, 'utf8').trim();
          phase(1, 3, 'BUILD — System A agents chạy từ requirement');

          // Write the requirement doc into the project repo (template
          // convention) so commands can reference it by path instead of
          // passing a huge document through argv.
          const docRel = p.build.requirementDoc;
          const docAbs = join(repoA, docRel);
          mkdirSync(dirname(docAbs), { recursive: true });
          writeFileSync(docAbs, requirement + '\n', 'utf8');
          ok(`Requirement written to ${docRel}`);

          const tokens = { requirement, requirementFile: reqFileAbs, requirementDoc: docRel };
          for (const raw of p.build.commands) {
            const command = substituteTokens(raw, tokens);
            cmd(command.join(' '));
            await runStageCommand(command, repoA);
          }
          ok('System A pipeline finished');
        } else {
          phase(1, 3, 'BUILD — bỏ qua' + (opts.skipBuild ? ' (--skip-build)' : ' (không cấu hình)'));
        }

        // ── GIAI ĐOẠN 2: deploy + health check ──
        if (!opts.skipDeploy) {
          phase(2, 3, 'DEPLOY — chạy script deploy của System A');
          if (p.deploy.command.includes('local')) {
            const envState = ensureDevEnv(repoA);
            if (envState === 'created') {
              ok('.env generated from .env.example (random dev secrets — local only)');
            }
          }
          cmd(p.deploy.command.join(' '));
          await runStageCommand(p.deploy.command, repoA);
          ok(`Deploy command finished — waiting for ${p.deploy.url} (max ${p.deploy.healthTimeoutSec}s)`);
          await waitForUrl(p.deploy.url, p.deploy.healthTimeoutSec);
          ok(`App is up: ${p.deploy.url}`);
        } else {
          phase(2, 3, 'DEPLOY — bỏ qua (--skip-deploy)');
          await waitForUrl(p.deploy.url, 10);
          ok(`App already up: ${p.deploy.url}`);
        }

        // ── GIAI ĐOẠN 3: the existing test + write-back chain ──
        phase(3, 3, 'TEST + WRITE-BACK — chuỗi BƯỚC 0-4');
        await runChain(config, { url: p.deploy.url, project: p.project, yes: opts.yes });
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    },
  );

program
  .command('input-only')
  .description('Stage 1 only: generate the System B input YAML (F10)')
  .requiredOption('--url <url>', 'deployed app base URL')
  .requiredOption('--project <name>', 'System B project name')
  .option('--dry-run', 'print YAML to stdout instead of writing', false)
  .action((opts: { url: string; project: string; dryRun: boolean }) => {
    const config = loadConfigOrDie(program.opts().config);
    const genOpts = { project: opts.project, baseUrl: opts.url };
    if (opts.dryRun) {
      const plan = planInput(config, genOpts);
      if (plan.mode === 'reuse') {
        ok(`would reuse existing ${plan.path}, updating baseUrl only`);
        return;
      }
      if (plan.mode === 'discovered') {
        const recipes = plannedRecipes(plan.discovery!, opts.project);
        for (const r of recipes) ok(`would generate ${r.relPath} (role ${r.role})`);
        console.log(buildInputYaml(config, genOpts, rolesFromDiscovery(plan.discovery!, recipes)));
        return;
      }
      console.log(buildInputYaml(config, genOpts));
      return;
    }
    runPreflightOrDie(config);
    const applied = applyInputPlan(config, genOpts);
    describeInput(applied, config, opts.url);
    ok(`${applied.plan.path} created`);
  });

program
  .command('collect-only')
  .description('Stages 3–4 only: parse an existing report and propose write-back (F10)')
  .option('--report <path>', 'explicit report file (default: newest under System B reports/)')
  .option('--yes', 'skip the human confirmation gate', false)
  .action(async (opts: { report?: string; yes: boolean }) => {
    const config = loadConfigOrDie(program.opts().config);
    runPreflightOrDie(config);

    const reportPath = opts.report ?? locateNewestReport(config);
    if (!reportPath) {
      fail(
        `No report found under ${resolveReportsDir(config)} — ` +
          `run System B first or pass --report <path>.`,
      );
      process.exit(1);
    }

    banner(1, 2, 'Thu kết quả');
    const run = parseReport(reportPath);
    reportLine(run);

    banner(2, 2, 'Đề xuất ghi ngược về SDLC docs');
    await proposeAndWriteback(config, run.failures, run.runId, opts.yes);
  });

program
  .command('new')
  .description('Khởi tạo project mới bằng wizard tương tác + chạy full workflow (CLI mode của Project Factory)')
  .action(async () => {
    const [{ runWizard, followJob }, { startJob }, { validateRequest, writeProjectFiles, projectPaths }] =
      await Promise.all([import('./wizard.js'), import('./web/jobs.js'), import('./web/bootstrap.js')]);
    const config = loadConfigOrDie(program.opts().config);
    if (!config.web.templateRepo) {
      fail('web.templateRepo chưa cấu hình trong connector.config.yaml (path local hoặc git URL của template).');
      process.exit(1);
    }

    const req = await runWizard(config);
    if (!req) {
      console.log(pc.dim('Đã hủy — chưa tạo gì cả.'));
      return;
    }
    const problems = validateRequest(req);
    if (problems.length > 0) {
      for (const p of problems) fail(p);
      process.exit(1);
    }

    const paths = projectPaths(config, req.name);
    writeProjectFiles(config, req, paths);
    startJob(config, req, process.cwd());
    console.log('');
    ok(`Job started — log: ${paths.logFile}`);
    const state = await followJob(config, req.name);

    console.log('');
    if (state.status === 'succeeded') {
      ok(`Project ${req.name} DONE`);
      console.log(`  repo project : ${paths.dir}`);
      console.log(`  app URL      : ${req.url}`);
      if (state.result?.totals) console.log(`  test totals  : ${JSON.stringify(state.result.totals)}`);
      const bugs = state.result?.bugsWritten ?? [];
      console.log(`  bugs ghi vào docs/bugs : ${bugs.length > 0 ? bugs.join(', ') : '0'}`);
      if (req.gitRemote) {
        console.log(
          `  GitHub       : ${req.gitRemote} ${state.result?.pushed ? pc.green('✓ pushed') : pc.yellow('⚠ chưa push được — xem log')}`,
        );
      }
    } else {
      fail(`Job failed ở bước "${state.step}": ${state.error ?? 'xem log'}`);
      console.log(pc.dim(`  log: ${paths.logFile}`));
      process.exit(1);
    }
  });

program
  .command('web')
  .description('Localhost project-factory UI: form → clone template → full pipeline → result')
  .option('--port <n>', 'port (default: web.port in config, 4000)')
  .action(async (opts: { port?: string }) => {
    const { startWebServer } = await import('./web/server.js');
    const config = loadConfigOrDie(program.opts().config);
    const port = opts.port ? Number(opts.port) : config.web.port;
    startWebServer(config, process.cwd(), port);
    ok(`Project Factory: http://127.0.0.1:${port} (Ctrl+C để dừng)`);
    if (!config.web.templateRepo) {
      warn('web.templateRepo chưa cấu hình — tạo project mới sẽ báo lỗi cho tới khi anh set nó.');
    }
  });

program.parseAsync().catch((e: unknown) => {
  fail((e as Error).message);
  process.exit(1);
});
