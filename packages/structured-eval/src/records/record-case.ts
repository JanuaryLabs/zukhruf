import type { Weighted } from '../scoring/scorecard-scorer.ts';

// What one test gives the record scorer: the expected record. A record case
// weighs 1.
export class RecordCase implements Weighted {
  readonly expected: unknown;
  readonly weight = 1;

  constructor(expected: unknown) {
    this.expected = expected;
  }

  static from(config: Readonly<Record<string, unknown>>): RecordCase {
    if (!('expected' in config))
      throw new Error(
        'A record case needs config.expected: the expected record of the test',
      );
    return new RecordCase(config['expected']);
  }
}
