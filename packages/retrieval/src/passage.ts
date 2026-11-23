/** One part of a source that a search gives back (CONTEXT.md, "Passage"). */
export type Passage = {
  readonly id: string;
  readonly text: string;
  /** The key of the row or file that the passage comes from. */
  readonly source: string;
  /** The position of the passage in its source. */
  readonly seq: number;
  readonly start: number;
  readonly end: number;
  readonly metadata: Readonly<Record<string, unknown>>;
};
