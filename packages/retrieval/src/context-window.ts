import { PassageGapError } from './passage-gap-error.ts';
import type { PassageStore } from './passage-store.ts';
import type { Metadata, StoredPassage } from './passage.ts';
import type { Postprocessor } from './postprocessor.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Widens each passage to its window: the passages of its source from
 * `seq - windowSize` to `seq + windowSize`, which the store gives (ADR 0008).
 * The text of the passage becomes the text of its window, merged as
 * Haystack's `SentenceWindowRetriever.merge_documents_text` merges it: in the
 * order of `start`, each passage adds the part of its text past the end of
 * the text before, so an overlap is not repeated, cut in code points as
 * `start` and `end` count them (ADR 0001). The passages of a source tile it
 * by contract, so the text is the exact part of the source from `start` to
 * `end` of the window; a passage that starts after the end of the text
 * before is a `PassageGapError`. `start` and `end` become those of the
 * window; the id, source, seq, metadata, score and vector stay. A passage
 * that the store gives no window for stays as it is (ADR 0008). It needs
 * stored passages: a live source's passage has no source or seq to widen
 * (ADR 0015). `M` is the metadata of its store, so a store of another typed
 * `M` does not compile; a bag store goes over any passages, which is harmless,
 * since a window keeps the passage's own metadata.
 */
export class ContextWindow<
  M extends Metadata = Metadata,
> implements Postprocessor<StoredPassage<M>> {
  readonly #store: PassageStore<M>;
  readonly #windowSize: number;

  constructor(options: {
    readonly store: PassageStore<M>;
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

  async postprocess<P extends StoredPassage<M>>(
    passages: readonly ScoredPassage<P>[],
    _query: string,
    options: { readonly abortSignal?: AbortSignal } = {},
  ): Promise<ScoredPassage<P>[]> {
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

function widen<P extends StoredPassage>(
  passage: P,
  window: readonly StoredPassage[],
): P {
  const ordered = window.toSorted((a, b) => a.start - b.start);
  const start = ordered[0]?.start ?? passage.start;
  let text = '';
  let end = start;
  for (const part of ordered) {
    if (part.start > end) {
      throw new PassageGapError(passage.source, end, part.start);
    }
    text += [...part.text].slice(end - part.start).join('');
    end = Math.max(end, part.end);
  }
  return { ...passage, text, start, end };
}
