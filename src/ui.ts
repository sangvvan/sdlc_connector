import pc from 'picocolors';

const LINE = '════════════════════════════════════════════';

/**
 * Step banner in the exact structure CLAUDE.md prescribes — the demo
 * talk-track depends on it. Banners Vietnamese, detail lines English.
 */
export function banner(step: number, total: number, title: string): void {
  console.log('');
  console.log(pc.cyan(LINE));
  console.log(pc.cyan(`║ BƯỚC ${step}/${total}  ${title}`));
  console.log(pc.cyan(LINE));
}

/** Pipeline-level banner (GIAI ĐOẠN) — one level above the BƯỚC banners. */
export function phase(step: number, total: number, title: string): void {
  console.log('');
  console.log(pc.magenta(pc.bold(`█ GIAI ĐOẠN ${step}/${total} — ${title}`)));
}

export function ok(msg: string): void {
  console.log(`${pc.green('✓')} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${pc.yellow('⚠')} ${msg}`);
}

export function fail(msg: string): void {
  console.error(`${pc.red('✗')} ${msg}`);
}

export function cmd(command: string): void {
  console.log(pc.dim(`$ ${command}`));
}
