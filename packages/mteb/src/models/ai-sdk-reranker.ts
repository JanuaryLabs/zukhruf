import type { RerankingModel } from 'ai';

import type { BatchedInput } from '../types/encoder-io.ts';
import { AiSdkTextReranker, pairUp } from './ai-sdk-text-reranker.ts';
import { ModelMeta } from './model-meta.ts';

export type AiSdkRerankerOptions = {
  readonly model: Exclude<RerankingModel, string>;
  // The metadata of the model. Without it, the name is the model id and the
  // revision is unknown.
  readonly modelMeta?: ModelMeta;
  // The retries of a failed call. MTEB makes 3 attempts.
  readonly maxRetries?: number;
};

// The text path of MTEB's OpenAIAPIRerankWrapper (models/openai_wrappers.py),
// with an AI SDK reranking model in place of HTTP requests to the /v1/rerank
// endpoint of an OpenAI-compatible server. The query is the text of the
// query with its instruction, and the document is its title and its text.
export class AiSdkReranker extends AiSdkTextReranker {
  constructor(options: AiSdkRerankerOptions) {
    super({
      model: options.model,
      modelMeta:
        options.modelMeta ??
        ModelMeta.createEmpty({
          name: options.model.modelId,
          modalities: ['text'],
        }),
      ...(options.maxRetries === undefined
        ? {}
        : { maxRetries: options.maxRetries }),
    });
  }

  protected pairs(
    inputs1: readonly BatchedInput[],
    inputs2: readonly BatchedInput[],
  ): [query: string, document: string][] {
    const queries = inputs1.flatMap((batch) => batch.text);
    const documents = inputs2.flatMap((batch) => batch.text);
    if (queries.length !== documents.length)
      throw new Error(
        `Expected equal number of queries and documents, got ${queries.length} queries and ${documents.length} documents`,
      );
    return pairUp(queries, documents);
  }
}
