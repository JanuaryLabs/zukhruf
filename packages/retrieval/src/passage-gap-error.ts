/**
 * The passages of one source do not tile it: a passage starts after the end
 * of the passages before it, so the text from `start` to `end` of the source
 * is in no passage. The passage contract requires that the passages of a
 * source tile it, white space kept and overlap allowed (ADR 0001), so the
 * writer of the contract broke it, and `ContextWindow` cannot give the text
 * of the window (ADR 0008).
 */
export class PassageGapError extends Error {
  override readonly name = 'PassageGapError';
  readonly source: string;
  /** The end of the passages before the gap, in code points. */
  readonly start: number;
  /** The start of the passage after the gap, in code points. */
  readonly end: number;

  constructor(source: string, start: number, end: number) {
    super(
      `The passages of the source ${source} have a gap from ${start} to ${end}: the passage contract requires that the passages of a source tile it`,
    );
    this.source = source;
    this.start = start;
    this.end = end;
  }
}
