#!/usr/bin/env tsx
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, type ConnectorConfig } from './config.js';
import { preflight, hasErrors } from './preflight.js';
import { buildInputYaml, writeInputFile } from './forward/inputgen.js';
import { invokeSystemB } from './forward/invoke.js';
import { locateNewReports, locateNewestReport, resolveReportsDir } from './collect/locate.js';
import { parseReport } from './collect/parse.js';
import type { Failure, RunResult } from './collect/model.js';
import { buildBugFile, type ProposedBug } from './writeback/bugmap.js';
import { nextBugNumber, existingSourceKeys } from './writeback/numbering.js';
import { buildBacklogAppendix, appendToBacklog } from './writeback/backlog.js';
import { confirmWriteback } from './writeback/gate.js';
import { RunSummary } from './report/summary.js';
import { banner, ok, warn, fail, cmd } from './ui.js';

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
    const summary = new RunSummary(opts.project, opts.url);
    const runStartedAt = new Date();

    try {
      banner(1, 4, 'Sinh input cho AI-Test từ app đã deploy');
      const inputPath = await summary.time('input-gen', () =>
        writeInputFile(config, { project: opts.project, baseUrl: opts.url }),
      );
      const crawl = config.crawl as { maxPages?: number };
      ok(
        `${join(config.systemB.inputsDir, `${opts.project}.yaml`)} created ` +
          `(${config.roles.length} roles, maxPages ${crawl.maxPages ?? '?'})`,
      );

      banner(2, 4, 'Chạy AI Automation Framework');
      const invoke = await summary.time('system-b-workflow', () =>
        invokeSystemB(config, inputPath),
      );
      cmd(invoke.command);

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
  });

program
  .command('input-only')
  .description('Stage 1 only: generate the System B input YAML (F10)')
  .requiredOption('--url <url>', 'deployed app base URL')
  .requiredOption('--project <name>', 'System B project name')
  .option('--dry-run', 'print YAML to stdout instead of writing', false)
  .action((opts: { url: string; project: string; dryRun: boolean }) => {
    const config = loadConfigOrDie(program.opts().config);
    if (opts.dryRun) {
      console.log(buildInputYaml(config, { project: opts.project, baseUrl: opts.url }));
      return;
    }
    runPreflightOrDie(config);
    const path = writeInputFile(config, { project: opts.project, baseUrl: opts.url });
    ok(`${path} created`);
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

program.parseAsync().catch((e: unknown) => {
  fail((e as Error).message);
  process.exit(1);
});
