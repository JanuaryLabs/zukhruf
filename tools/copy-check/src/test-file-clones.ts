import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runJscpd } from 'jscpd';

export interface CloneSide {
  name: string;
  start: number;
  end: number;
}

export interface Clone {
  first: CloneSide;
  second: CloneSide;
  tokens: number;
}

interface ReportSide {
  name: string;
  startLoc: { line: number };
  endLoc: { line: number };
}

interface Report {
  duplicates: {
    firstFile: ReportSide;
    secondFile: ReportSide;
    tokens: number;
  }[];
}

/**
 * The size of a helper: about 20 lines. Measured on 2026-11-09: from 50 to 75
 * tokens, 23% of the hits hold a whole helper or test, and the rest are imports
 * and arrange steps. From 100 to 150 tokens, 63% hold one.
 */
const MIN_TOKENS = 100;

/** The test files of root ADR 0001: `*.test.*`, `*.spec.*` and `src/testing`. */
const TEST_FILES = '**/{*.test.*,*.spec.*,src/testing/**}';

/**
 * The blocks that two test files have in common, byte for byte. A block that
 * repeats in one file is the arrange step of each test, which no ledger holds.
 */
export async function clonesBetweenTestFiles(
  workspace: string,
): Promise<Clone[]> {
  await using output = await mkdtempDisposable(join(tmpdir(), 'copy-check-'));
  const run = runJscpd(
    [
      '.',
      `--pattern=${TEST_FILES}`,
      '--mode=strict',
      '--kind=exact',
      `--min-tokens=${MIN_TOKENS}`,
      '--reporters=json',
      `--output=${output.path}`,
      // A wrong glob finds no files, and no files means no copies.
      '--fail-on-empty',
      '--silent',
    ],
    { cwd: workspace, encoding: 'utf8' },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(
      `jscpd exited with ${run.status}: ${run.stdout}${run.stderr}`,
    );
  }
  const report: Report = JSON.parse(
    await readFile(join(output.path, 'jscpd-report.json'), 'utf8'),
  );
  return report.duplicates
    .filter(({ firstFile, secondFile }) => firstFile.name !== secondFile.name)
    .map(({ firstFile, secondFile, tokens }) => ({
      first: side(firstFile),
      second: side(secondFile),
      tokens,
    }));
}

function side({ name, startLoc, endLoc }: ReportSide): CloneSide {
  return { name, start: startLoc.line, end: endLoc.line };
}
