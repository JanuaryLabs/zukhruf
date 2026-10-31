import { zipStrictMismatch } from '../dependencies/python.ts';
import type { BatchedInput } from '../types/encoder-io.ts';
import { AiSdkTextReranker, pairUp } from './ai-sdk-text-reranker.ts';
import type { CrossEncoderKwargs, LoaderOptions } from './model-meta.ts';

// mteb/models/sentence_transformer_wrapper.py: the text path of
// CrossEncoderWrapper, with an AI SDK reranking model of a server that
// serves the weights in place of a sentence-transformers CrossEncoder. The
// encoder wrappers of that module are not ported. query_prefix and
// passage_prefix are not ported: no metadata of MTEB sets them.

// Scores the text of each query with the text of each document.
export class CrossEncoderWrapper extends AiSdkTextReranker {
  protected pairs(
    inputs1: readonly BatchedInput[],
    inputs2: readonly BatchedInput[],
  ): [query: string, document: string][] {
    const queries = inputs1.flatMap((batch) => batch.text);
    const documents = inputs2.flatMap((batch) => batch.text);
    const mismatch = zipStrictMismatch([queries.length, documents.length]);
    if (mismatch !== null) throw new Error(mismatch);
    return pairUp(queries, documents);
  }
}

export function crossEncoderWrapperLoader(
  _name: string,
  _revision: string | null,
  options: LoaderOptions<CrossEncoderKwargs>,
): CrossEncoderWrapper {
  return new CrossEncoderWrapper({
    model: options.model,
    modelMeta: options.modelMeta,
  });
}
// model_meta.json names a loader by MTEB's __name__, and MTEB finds the loader
// in its registry by that name.
Object.defineProperty(crossEncoderWrapperLoader, 'name', {
  value: 'CrossEncoderWrapper',
});
