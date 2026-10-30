import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import type { Design } from '../src/index.ts';
import type { Pin } from './scoreboard.ts';

const PACKAGE_FOLDER = join(import.meta.dirname, '..');

// The pin of a design that the package runs now. The commit is HEAD, and it
// holds this detector only when src/ has no change that is not committed:
// committed() says so.
export function currentPin(design: Design): Pin {
  return { commit: git('rev-parse', 'HEAD'), design };
}

export function committed(): boolean {
  return git('status', '--porcelain', '--', 'src') === '';
}

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: PACKAGE_FOLDER,
    encoding: 'utf8',
  }).trim();
}
