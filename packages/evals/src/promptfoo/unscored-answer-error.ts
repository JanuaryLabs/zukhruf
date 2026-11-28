// A run with answers that no assertion scored: promptfoo graded each such row
// as failed (ASSERT) with no named score, because its assertion threw or
// failed with no score. promptfoo writes the two the same way, and only its
// reason tells them apart (ADR 0009). Either way the score of its test is
// unknown, not the score of the answer null (ADR 0005), so PromptfooSamples
// refuses the run instead of reading the test with no scores, which would
// leave it out of every whole. A host catches it by its type and reads the
// tests from `tests`.
export class UnscoredAnswerError extends Error {
  override readonly name = 'UnscoredAnswerError';
  // Each test and epoch whose answer no assertion scored, with promptfoo's
  // reason (gradingResult.reason).
  readonly tests: readonly {
    readonly test: string;
    readonly epoch: number;
    readonly reason: string;
  }[];

  constructor(tests: UnscoredAnswerError['tests']) {
    super(
      `A run with answers that no assertion scored has no score for their tests: an assertion threw or failed without a score; fix the assertion and run promptfoo eval again. Unscored: ${tests
        .map(({ test, epoch, reason }) => `${test} (epoch ${epoch}): ${reason}`)
        .join(', ')}`,
    );
    this.tests = tests;
  }
}
