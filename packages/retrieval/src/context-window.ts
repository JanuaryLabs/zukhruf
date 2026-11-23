import type { PassageStore } from './passage-store.ts';
import type { Passage } from './passage.ts';
import type { Postprocessor } from './postprocessor.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Widens each passage to its window: the passages of its source from
 * `seq - windowSize` to `seq + windowSize`, which the store gives (ADR 0008).
 * The text of the passage becomes the text of its window, merged as
 * Haystack's `SentenceWindowRetriever.merge_documents_text` merges it: in the
 * order of `start`, each passage adds the part of its text past the end of
 * the text before, so an overlap is not repeated. `start` and `end` become
 * those of the window; the id, source, seq, metadata, score and vector stay.
 * A passage that the store gives no window for stays as it is (ADR 0008, the
 * proposed amendment of 2026-11-23).
 */
export class ContextWindow implements Postprocessor {
  readonly #store: PassageStore;
  readonly #windowSize: number;

  constructor(options: {
    readonly store: PassageStore;
    /** How many passages before and after: 3 when absent, as Haystack's `window_size`. */
    readonly windowSize?: number;
  }) {
    this.#store = options.store;
    this.#windowSize = options.windowSize ?? 3;
    if (!Number.isInteger(this.#windowSize) || this.#windowSize < 1) {
      throw new RangeError(
        `The windowSize is a positive integer, not ${this.#windowSize}`,
      );
    }
  }

  async postprocess(
    passages: readonly ScoredPassage[],
    _query: string,
    options: { readonly abortSignal?: AbortSignal } = {},
  ): Promise<ScoredPassage[]> {
    options.abortSignal?.throwIfAborted();
    return Promise.all(
      passages.map(async (scored) => {
        const window = await this.#store.neighbours({
          source: scored.passage.source,
          seq: scored.passage.seq,
          windowSize: this.#windowSize,
        });
        return window.length === 0
          ? scored
          : { ...scored, passage: widen(scored.passage, window) };
      }),
    );
  }
}

function widen(passage: Passage, window: readonly Passage[]): Passage {
  let text = '';
  let end = 0;
  const ordered = window.toSorted((a, b) => a.start - b.start);
  for (const part of ordered) {
    text += part.text.slice(Math.max(0, end - part.start));
    end = Math.max(end, part.end);
  }
  return {
    ...passage,
    text,
    start: Math.min(...ordered.map(({ start }) => start)),
    end,
  };
}
