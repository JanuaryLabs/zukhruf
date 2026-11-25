/** The metadata of a passage: the host's own fields, after LangChain.js `Document<Metadata>` (ADR 0015). */
export type Metadata = Readonly<Record<string, unknown>>;

/**
 * One part of a source that a search gives back, from any retriever
 * (CONTEXT.md, "Passage"). A live source, such as a web search, gives this
 * type: it has no row to point back to (ADR 0015).
 */
export type Passage<M extends Metadata = Metadata> = {
  readonly id: string;
  readonly text: string;
  readonly metadata: M;
};

/**
 * A passage of the passage contract (ADR 0001): the engine retrievers and the
 * passage stores give it (CONTEXT.md, "Stored passage"). Only it has the
 * coordinates of its row, as LlamaIndex puts `start_char_idx` on `TextNode`,
 * not on `BaseNode` (ADR 0015).
 */
export type StoredPassage<M extends Metadata = Metadata> = Passage<M> & {
  /** The key of the row or file that the passage comes from. */
  readonly source: string;
  /** The position of the passage in its source. */
  readonly seq: number;
  readonly start: number;
  readonly end: number;
};
