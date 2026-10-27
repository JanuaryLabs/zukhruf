import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as design from '../src/frozen-design.ts';
import { sha256 } from './answer-key.ts';
import type { Pin } from './scoreboard.ts';

const PACKAGE_FOLDER = join(import.meta.dirname, '..');

// The pin of the design that the package holds now. The commit is HEAD, and
// it holds this design only when src/ has no change that is not committed:
// committed() says so.
export function currentPin(): Pin {
  const { PLAN_SHA256, ...constants } = design;
  return {
    commit: git('rev-parse', 'HEAD'),
    planSha256: PLAN_SHA256,
    frozenDesignSha256: sha256(
      readFileSync(join(PACKAGE_FOLDER, 'src', 'frozen-design.ts')),
    ),
    constants,
  };
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
