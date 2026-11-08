import type { Scorecard } from './scorecard.ts';
import { TestEpochs } from './test-epochs.ts';

// The tests of each run, in the order of their first add. PairedBootstrap of
// this package reads them through runTests; the package does not export it.
const testsOfRun = new WeakMap<Run, Map<string, TestEpochs>>();
const testsOf = (run: Run) =>
  testsOfRun.getOrInsertComputed(run, () => new Map());

// The scorecards of one model on many tests. A second add of a test id is
// one more epoch of that test.
export class Run {
  add(testId: string, scorecard: Scorecard, weight: number): void {
    const test = testsOf(this).getOrInsertComputed(
      testId,
      () => new TestEpochs(weight),
    );
    if (test.weight !== weight)
      throw new RangeError(
        `Test "${testId}" has the weight ${test.weight}, not ${weight}: the weight belongs to the case`,
      );
    test.add(scorecard);
  }
}

export function runTests(run: Run): ReadonlyMap<string, TestEpochs> {
  return testsOf(run);
}
