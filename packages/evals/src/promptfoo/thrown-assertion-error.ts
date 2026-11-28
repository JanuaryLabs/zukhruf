// A run in which an assertion threw on some tests. A thrown assertion is a
// defect of the scorer, not a failed call (ADR 0005): the score of such a
// test is unknown, not the score of the answer null, so PromptfooSamples
// refuses the run instead of reading the test with no scores. A host catches
// it by its type and reads the tests from `tests`.
export class ThrownAssertionError extends Error {
  override readonly name = 'ThrownAssertionError';
  // Each test and epoch whose assertion threw, with promptfoo's reason.
  readonly tests: readonly {
    readonly test: string;
    readonly epoch: number;
    readonly reason: string;
  }[];

  constructor(tests: ThrownAssertionError['tests']) {
    super(
      `A run in which an assertion threw has no score for its test; fix the assertion and run promptfoo eval again. Threw: ${tests
        .map(({ test, epoch, reason }) => `${test} (epoch ${epoch}): ${reason}`)
        .join(', ')}`,
    );
    this.tests = tests;
  }
}
