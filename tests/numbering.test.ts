import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existingSourceKeys, nextBugNumber } from '../src/writeback/numbering.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('nextBugNumber', () => {
  it('starts at 1 for an empty bugs dir', () => {
    expect(nextBugNumber(dir)).toBe(1);
  });

  it('returns 1 for a missing dir (preflight catches this earlier)', () => {
    expect(nextBugNumber(join(dir, 'nope'))).toBe(1);
  });

  it('continues from the max existing number', () => {
    writeFileSync(join(dir, 'BUG-003.md'), '# BUG-003');
    writeFileSync(join(dir, 'BUG-010.md'), '# BUG-010');
    expect(nextBugNumber(dir)).toBe(11);
  });

  it('handles unpadded numbering too', () => {
    writeFileSync(join(dir, 'BUG-7.md'), '# BUG-7');
    expect(nextBugNumber(dir)).toBe(8);
  });

  it('ignores files not matching BUG-{n}.md', () => {
    writeFileSync(join(dir, 'BUG-002.md'), '# BUG-002');
    writeFileSync(join(dir, 'README.md'), '# readme');
    writeFileSync(join(dir, 'BUG-notes.md'), '# notes');
    writeFileSync(join(dir, 'BUG-099.txt'), 'not md');
    expect(nextBugNumber(dir)).toBe(3);
  });
});

describe('existingSourceKeys (idempotency, F11)', () => {
  it('is empty when no bugs exist', () => {
    expect(existingSourceKeys(dir).size).toBe(0);
  });

  it('collects ai-test-source keys from existing bug files', () => {
    const key = 'NF-SEC-001|http://localhost:3000/auth/login|Validate email input';
    writeFileSync(join(dir, 'BUG-001.md'), `# BUG-001: x\n\n<!-- ai-test-source: ${key} -->\n`);
    writeFileSync(join(dir, 'BUG-002.md'), '# BUG-002: manual bug, no source line\n');
    const keys = existingSourceKeys(dir);
    expect(keys.has(key)).toBe(true);
    expect(keys.size).toBe(1);
  });
});
