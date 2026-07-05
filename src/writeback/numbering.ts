import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BUG_FILE_RE = /^BUG-(\d+)\.md$/;

/** List BUG-*.md filenames in a bugs dir ([] if dir missing). */
function listBugFiles(bugsDirAbs: string): string[] {
  try {
    return readdirSync(bugsDirAbs).filter((n) => BUG_FILE_RE.test(n));
  } catch {
    return [];
  }
}

/**
 * Next BUG number: scan existing docs/bugs/BUG-*.md, take max + 1 (F6).
 * Numbering treated as global across sprints (OQ-4 assumption — see README).
 */
export function nextBugNumber(bugsDirAbs: string): number {
  let max = 0;
  for (const name of listBugFiles(bugsDirAbs)) {
    const m = BUG_FILE_RE.exec(name);
    const n = Number(m![1]);
    if (n > max) max = n;
  }
  return max + 1;
}

const SOURCE_KEY_RE = /<!--\s*ai-test-source:\s*(.+?)\s*-->/g;

/**
 * Collect the ai-test source keys already recorded in existing BUG files,
 * for idempotent collection (F11): a failure whose key is present is
 * skipped instead of duplicated.
 */
export function existingSourceKeys(bugsDirAbs: string): Set<string> {
  const keys = new Set<string>();
  for (const name of listBugFiles(bugsDirAbs)) {
    let content: string;
    try {
      content = readFileSync(join(bugsDirAbs, name), 'utf8');
    } catch {
      continue;
    }
    for (const m of content.matchAll(SOURCE_KEY_RE)) {
      keys.add(m[1]!);
    }
  }
  return keys;
}
