import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface StageTiming {
  stage: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'ok' | 'failed' | 'skipped';
  detail?: string;
}

/** Tracks per-stage timings for the connector run summary JSON (F9). */
export class RunSummary {
  private stages: StageTiming[] = [];
  private readonly startedAt = new Date();

  constructor(
    private readonly project: string,
    private readonly url: string,
  ) {}

  async time<T>(stage: string, fn: () => Promise<T> | T): Promise<T> {
    const start = new Date();
    try {
      const result = await fn();
      this.push(stage, start, 'ok');
      return result;
    } catch (e) {
      this.push(stage, start, 'failed', (e as Error).message);
      throw e;
    }
  }

  skip(stage: string, detail: string): void {
    const now = new Date();
    this.stages.push({
      stage,
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: 0,
      status: 'skipped',
      detail,
    });
  }

  private push(stage: string, start: Date, status: 'ok' | 'failed', detail?: string): void {
    const end = new Date();
    this.stages.push({
      stage,
      startedAt: start.toISOString(),
      finishedAt: end.toISOString(),
      durationMs: end.getTime() - start.getTime(),
      status,
      ...(detail ? { detail } : {}),
    });
  }

  /** Write summary-{timestamp}.json into summaryDir; returns the path. */
  write(summaryDir: string, extra: Record<string, unknown> = {}): string {
    const dir = resolve(summaryDir);
    mkdirSync(dir, { recursive: true });
    const stamp = this.startedAt.toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `summary-${stamp}.json`);
    const doc = {
      project: this.project,
      url: this.url,
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      stages: this.stages,
      ...extra,
    };
    writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8');
    return path;
  }
}
