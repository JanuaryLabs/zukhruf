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
  add(
    testId: string,
    scorecard: Pick<Scorecard, 'ratios'>,
    weight: number,
  ): void {
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

// The tests of two runs, paired by test id in the order of the baseline's
// first adds. The pairing refuses a test id that one run does not have, as
// mteb's pairedBootstrapTest refuses (strike 2, docs/copied-code.md), and a
// test whose weight is not the same in the two runs. The subject names what
// needs the pairing, such as a paired bootstrap or a run pair. PairedBootstrap
// and RunPair of this package pair through it; the package does not export it.
export function pairTests(
  baseline: Run,
  change: Run,
  subject: string,
): { id: string; baseline: TestEpochs; change: TestEpochs }[] {
  const baselineTests = testsOf(baseline);
  const changeTests = testsOf(change);
  const unpaired = [...baselineTests.keys(), ...changeTests.keys()].filter(
    (id) => !(baselineTests.has(id) && changeTests.has(id)),
  );
  if (unpaired.length > 0)
    throw new RangeError(
      `${subject} needs the same test ids in the baseline and the change. Not in both: ${unpaired.join(', ')}`,
    );
  const joined = [...baselineTests].flatMap(([id, test]) => {
    const changeTest = changeTests.get(id);
    return changeTest === undefined
      ? []
      : [{ id, baseline: test, change: changeTest }];
  });
  const reweighted = joined.filter(
    (test) => test.baseline.weight !== test.change.weight,
  );
  if (reweighted.length > 0)
    throw new RangeError(
      `A test has the same weight in the baseline and the change. Other weights: ${reweighted
        .map(
          (test) =>
            `${test.id} (${test.baseline.weight} and ${test.change.weight})`,
        )
        .join(', ')}`,
    );
  return joined;
}
