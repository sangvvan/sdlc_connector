import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import pc from 'picocolors';
import type { ConnectorConfig } from './config.js';
import {
  AI_PROVIDERS,
  BUILD_MODES,
  DEPLOY_TARGETS,
  parseGitHubRepo,
  projectPaths,
  type NewProjectRequest,
} from './web/bootstrap.js';
import { loadState, type JobState } from './web/jobs.js';

/**
 * `connect new` — the terminal twin of the Project Factory form: one
 * question per field, Enter accepts the [default], answers validated on
 * the spot. Produces the same NewProjectRequest the web UI posts.
 */

/**
 * readline drops lines that arrive while no question() is pending —
 * with piped stdin every answer lands in one chunk and all but the
 * first would be lost. Prompter keeps a persistent 'line' listener and
 * queues answers so both interactive TTY and piped input work.
 */
class Prompter {
  private queue: string[] = [];
  private waiters: ((line: string | null) => void)[] = [];
  private closed = false;

  constructor(rl: Interface) {
    rl.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.queue.push(line);
    });
    rl.on('close', () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
  }

  /** Next answer line; '' = user pressed Enter, null = stdin closed. */
  async question(prompt: string): Promise<string | null> {
    process.stdout.write(prompt);
    // Piped stdin doesn't echo like a TTY does — echo answers ourselves
    // so transcripts stay readable.
    const echo = (line: string | null): void => {
      if (line !== null && !process.stdin.isTTY) process.stdout.write(`${line}\n`);
    };
    const queued = this.queue.shift();
    if (queued !== undefined) {
      echo(queued);
      return queued;
    }
    if (this.closed) return null;
    return new Promise((resolvePromise) =>
      this.waiters.push((line) => {
        echo(line);
        resolvePromise(line);
      }),
    );
  }
}

interface AskOptions {
  def?: string;
  optional?: boolean;
  /** Return an error message to re-ask, or undefined to accept. */
  validate?: (answer: string) => string | undefined;
}

async function ask(p: Prompter, label: string, opts: AskOptions = {}): Promise<string> {
  for (;;) {
    const suffix = opts.def
      ? pc.dim(` [${opts.def}]`)
      : opts.optional
        ? pc.dim(' [Enter để bỏ qua]')
        : '';
    const line = await p.question(`${pc.bold(label)}${suffix}: `);
    if (line === null) {
      throw new Error('stdin đã đóng giữa chừng — thiếu câu trả lời cho wizard');
    }
    const answer = line.trim() || opts.def || '';
    if (!answer && !opts.optional) {
      console.log(pc.red('  → bắt buộc, nhập lại nhé'));
      continue;
    }
    const problem = answer && opts.validate ? opts.validate(answer) : undefined;
    if (problem) {
      console.log(pc.red(`  → ${problem}`));
      continue;
    }
    return answer;
  }
}

async function askYesNo(p: Prompter, label: string, def = false): Promise<boolean> {
  const answer = await ask(p, label, { def: def ? 'Y' : 'N' });
  return answer.toLowerCase().startsWith('y');
}

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** Run the interactive questionnaire; returns the request or undefined if declined. */
export async function runWizard(config: ConnectorConfig): Promise<NewProjectRequest | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const p = new Prompter(rl);
  try {
    console.log(pc.cyan(pc.bold('\n🔗 Project Factory — khởi tạo project mới\n')));

    const name = await ask(p, 'Tên project (vd: learning-hub)', {
      validate: (v) => {
        if (!NAME_RE.test(v)) return 'chữ thường/số/gạch ngang, bắt đầu bằng chữ';
        if (existsSync(projectPaths(config, v).dir))
          return `projects/${v}/ đã tồn tại — chạy \`connect rm ${v}\` để xoá, hoặc chọn tên khác`;
        return undefined;
      },
    });

    const requirementFile = await ask(p, 'File requirement/.md (đường dẫn)', {
      validate: (v) => {
        const abs = resolve(v);
        if (!existsSync(abs)) return `không thấy file: ${abs}`;
        if (readFileSync(abs, 'utf8').trim().length < 10) return 'file requirement quá ngắn';
        return undefined;
      },
    });

    const techStack = await ask(p, 'Tech stack (thêm vào requirement)', { optional: true });

    console.log(pc.dim('  opencode = LM Studio / Ollama local (không tốn token cloud)'));
    const aiProvider = await ask(p, `AI provider (${AI_PROVIDERS.join(' | ')})`, {
      def: 'claude',
      validate: (v) =>
        (AI_PROVIDERS as readonly string[]).includes(v)
          ? undefined
          : `chọn một trong: ${AI_PROVIDERS.join(', ')}`,
    });

    console.log(
      pc.dim(
        '  foundation = chỉ sinh REQ/US/TASK/design docs rồi dừng — team chọn việc chạy dần bằng `connect work` (tiết kiệm token)\n' +
          '  full       = build code + deploy + AI test trọn chuỗi',
      ),
    );
    const buildMode = (await ask(p, `Build mode (${BUILD_MODES.join(' | ')})`, {
      def: 'foundation',
      validate: (v) =>
        (BUILD_MODES as readonly string[]).includes(v) ? undefined : 'foundation hoặc full',
    })) as NewProjectRequest['buildMode'];

    let deployTarget = 'local';
    let url = 'http://localhost:3000';
    if (buildMode === 'full') {
      console.log(pc.dim(`  deploy targets: ${DEPLOY_TARGETS.join(' | ')}`));
      deployTarget = await ask(p, 'Deploy lên đâu', {
        def: 'local',
        validate: (v) =>
          (DEPLOY_TARGETS as readonly string[]).includes(v)
            ? undefined
            : 'không có target này (xem danh sách trên)',
      });

      url = await ask(p, 'URL app sau deploy', {
        def: 'http://localhost:3000',
        validate: (v) => {
          try {
            new URL(v);
            return undefined;
          } catch {
            return 'URL không hợp lệ';
          }
        },
      });
    }

    const gitRemote = await ask(p, 'GitHub repo (có sẵn thì dùng, chưa có thì tạo private)', {
      optional: true,
      validate: (v) =>
        parseGitHubRepo(v)
          ? undefined
          : 'dùng https://github.com/owner/repo hoặc git@github.com:owner/repo.git',
    });

    let skipBuild = false;
    let skipDeploy = false;
    if (buildMode === 'full') {
      skipBuild = await askYesNo(p, 'Bỏ qua build (code đã có sẵn)?');
      skipDeploy = await askYesNo(p, 'App đang chạy sẵn (bỏ qua deploy)?');
    }

    const req: NewProjectRequest = {
      name,
      requirement: readFileSync(resolve(requirementFile), 'utf8'),
      techStack: techStack || undefined,
      aiProvider,
      buildMode,
      deployTarget,
      url,
      gitRemote: gitRemote || undefined,
      skipBuild,
      skipDeploy,
    };

    console.log('');
    console.log(pc.bold('Tóm tắt:'));
    console.log(`  project      : ${req.name}`);
    console.log(`  requirement  : ${resolve(requirementFile)}`);
    console.log(`  tech stack   : ${req.techStack ?? '(mặc định template)'}`);
    console.log(`  AI provider  : ${req.aiProvider}`);
    console.log(
      `  build mode   : ${req.buildMode}${req.buildMode === 'foundation' ? ' (kiến thiết docs, không implement/deploy/test)' : ''}`,
    );
    if (req.buildMode === 'full') {
      console.log(`  deploy       : ${req.deployTarget}${req.skipDeploy ? ' (bỏ qua — app chạy sẵn)' : ''}`);
      console.log(`  app URL      : ${req.url}`);
      console.log(`  build        : ${req.skipBuild ? 'bỏ qua' : 'chạy AI agents'}`);
    }
    console.log(`  GitHub repo  : ${req.gitRemote ?? '(không push)'}`);
    const go = await askYesNo(p, '\n🚀 Bắt đầu full workflow?', true);
    return go ? req : undefined;
  } finally {
    rl.close();
  }
}

/**
 * Follow a background kickoff job from the terminal: stream the log file
 * as it grows, return the final state when the job leaves 'running'.
 */
export async function followJob(config: ConnectorConfig, name: string): Promise<JobState> {
  const { logFile } = projectPaths(config, name);
  let pos = 0;
  const flush = (): void => {
    try {
      const data = readFileSync(logFile);
      if (data.length > pos) {
        process.stdout.write(data.subarray(pos));
        pos = data.length;
      }
    } catch {
      // log not created yet
    }
  };
  for (;;) {
    flush();
    const state = loadState(config, name);
    if (state && state.status !== 'running') {
      flush();
      return state;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
