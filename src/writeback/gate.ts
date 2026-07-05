import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import type { ProposedBug } from './bugmap.js';

/**
 * Human confirmation gate (F7 / AC-6): print the write-back summary and
 * wait for explicit approval. Nothing touches System A's docs/ before
 * this returns true. `--yes` bypasses for demo/CI.
 */
export async function confirmWriteback(
  bugs: ProposedBug[],
  skippedDuplicates: number,
  yes: boolean,
): Promise<boolean> {
  if (bugs.length === 0) {
    console.log(pc.green('Nothing to write — no new failures to map.'));
    return false;
  }

  const first = bugs[0]!.fileName.replace('.md', '');
  const last = bugs[bugs.length - 1]!.fileName.replace('.md', '');
  const range = bugs.length === 1 ? first : `${first}..${last}`;
  console.log(
    `${bugs.length} failures → ${bugs.length} proposed bug files (${range}) + ${bugs.length} backlog candidates`,
  );
  if (skippedDuplicates > 0) {
    console.log(pc.dim(`(${skippedDuplicates} already mapped in earlier runs — skipped)`));
  }
  for (const b of bugs) {
    console.log(
      pc.dim(
        `  ${b.fileName}  [${b.failure.priority}/${b.failure.severity}] ${b.failure.title} — ${b.failure.pageUrl}`,
      ),
    );
  }

  if (yes) {
    console.log(pc.yellow('👤 HUMAN GATE: bypassed with --yes'));
    return true;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(pc.bold('👤 HUMAN GATE: ghi vào docs/? [y/N] '));
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}
