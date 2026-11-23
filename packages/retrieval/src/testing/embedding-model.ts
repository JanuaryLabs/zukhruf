import { MockEmbeddingModelV4 } from 'ai/test';

/**
 * A real embedding model cannot run in CI. The AI SDK's own mock model gives
 * the vector that the test names for each text, fails for any other text, and
 * records each call. With `signals`, it also records the abort signal of each
 * text it embeds.
 */
export function embeddingModel(
  vectors: Readonly<Record<string, readonly number[]>>,
  {
    provider = 'test',
    modelId = 'mini',
    signals,
  }: {
    readonly provider?: string;
    readonly modelId?: string;
    readonly signals?: (AbortSignal | undefined)[];
  } = {},
): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    provider,
    modelId,
    maxEmbeddingsPerCall: 100,
    doEmbed: async ({ values, abortSignal }) => ({
      embeddings: values.map((text) => {
        signals?.push(abortSignal);
        const vector = vectors[text];
        if (vector === undefined)
          throw new Error(`The test names no vector for ${text}`);
        return [...vector];
      }),
      warnings: [],
    }),
  });
}
