#!/usr/bin/env tsx
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, type ConnectorConfig } from './config.js';
import { preflight, hasErrors } from './preflight.js';
import { buildInputYaml, writeInputFile } from './forward/inputgen.js';
import { invokeSystemB } from './forward/invoke.js';
import { locateNewestReport } from './collect/locate.js';
import { parseReport } from './collect/parse.js';
import type { RunResult } from './collect/model.js';
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

interface WritebackOutcome {
  written: ProposedBug[];
  skippedDuplicates: number;
  approved: boolean;
}

/**
 * Propose BUG files + backlog candidates for the run's failures, behind
 * the human gate. Idempotent: failures whose source key already exists in
 * docs/bugs/ are skipped (F11). Nothing is written before approval.
 */
async function proposeAndWriteback(
  config: ConnectorConfig,
  run: RunResult,
  yes: boolean,
): Promise<WritebackOutcome> {
  const bugsDir = join(config.systemA.repoPath, config.systemA.bugsDir);
  const known = existingSourceKeys(bugsDir);

  const fresh = run.failures.filter((f) => !known.has(f.sourceKey));
  const skippedDuplicates = run.failures.length - fresh.length;

  let n = nextBugNumber(bugsDir);
  const proposed = fresh.map((f) => buildBugFile(f, n++, run.runId));

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
    appendToBacklog(backlogFile, buildBacklogAppendix(written, run.runId));
    ok(`${written.length} BUG files created in ${config.systemA.bugsDir}/`);
    ok(`${written.length} candidates appended to ${config.systemA.backlogFile}`);
  }
  return { written, skippedDuplicates, approved };
}

function reportWarnings(run: RunResult): void {
  for (const w of run.warnings) warn(`parser: ${w}`);
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
      const run = await summary.time('collect', () => {
        const reportPath = locateNewestReport(config, runStartedAt);
        if (!reportPath) {
          // OQ-2 resolution: exit code alone doesn't decide — a missing
          // report is what distinguishes "could not run" from "ran with
          // failures" (failures are the payload, not an error).
          throw new Error(
            `System B exited with code ${invoke.exitCode} and no new report appeared under ` +
              `${join(config.systemB.repoPath, config.systemB.reportsDir)} — infrastructure error.`,
          );
        }
        return parseReport(reportPath);
      });
      ok(
        `Report: ${run.reportPath} — ${run.totals.total} total, ` +
          `${run.totals.passed} passed, ${run.totals.failed} failed`,
      );
      reportWarnings(run);

      banner(4, 4, 'Đề xuất ghi ngược về SDLC docs');
      const outcome = await summary.time('write-back', () =>
        proposeAndWriteback(config, run, opts.yes),
      );
      if (!outcome.approved && run.failures.length > 0) {
        console.log(pc.dim('Write-back declined — System A docs untouched.'));
      }

      const summaryPath = summary.write(config.summaryDir, {
        runId: run.runId,
        totals: run.totals,
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
        `No report found under ${join(config.systemB.repoPath, config.systemB.reportsDir)} — ` +
          `run System B first or pass --report <path>.`,
      );
      process.exit(1);
    }

    banner(1, 2, 'Thu kết quả');
    const run = parseReport(reportPath);
    ok(
      `Report: ${run.reportPath} — ${run.totals.total} total, ` +
        `${run.totals.passed} passed, ${run.totals.failed} failed`,
    );
    reportWarnings(run);

    banner(2, 2, 'Đề xuất ghi ngược về SDLC docs');
    await proposeAndWriteback(config, run, opts.yes);
  });

program.parseAsync().catch((e: unknown) => {
  fail((e as Error).message);
  process.exit(1);
});
