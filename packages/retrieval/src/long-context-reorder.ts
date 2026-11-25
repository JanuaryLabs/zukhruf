import type { Passage } from './passage.ts';
import type { Postprocessor } from './postprocessor.ts';
import type { RankedPassage } from './ranked-passage.ts';

/**
 * Puts the best passages at the two ends of the list and the worst in the
 * middle, where a language model reads a long context worst (Liu et al.,
 * "Lost in the Middle", 2023, arXiv:2307.03172). The algorithm is copied from
 * LangChain's `_litm_reordering`
 * (langchain_community/document_transformers/long_context_reorder.py): the
 * list, best first, is reversed, and each passage in turn goes to the front
 * at an even position and to the back at an odd one. LlamaIndex's
 * `LongContextReorder` (llama_index/core/postprocessor/node.py) gives the
 * same order for a list sorted best first. The scores stay; the list is no
 * longer sorted by them.
 */
export class LongContextReorder implements Postprocessor<Passage> {
  async postprocess<I extends RankedPassage>(
    passages: readonly I[],
    _query?: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<I[]> {
    options.signal?.throwIfAborted();
    const reordered: I[] = [];
    for (const [index, passage] of passages.toReversed().entries()) {
      if (index % 2 === 1) reordered.push(passage);
      else reordered.unshift(passage);
    }
    return reordered;
  }
}
