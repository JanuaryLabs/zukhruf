import type { EmbeddingModelMiddleware } from 'ai';

// The task prompts of EmbeddingGemma 2 that Venn accepts (venn/reader.py
// PROMPTS), as the config_sentence_transformers.json of the model writes
// them. venn-1 reads vectors of the Classification prompt.
const PROMPTS = {
  Classification: 'task: classification | query: ',
  SentenceSimilarity: 'task: sentence similarity | query: ',
  Clustering: 'task: clustering | query: ',
} as const;

export type ReaderPrompt = keyof typeof PROMPTS;

// Puts the prefix of the prompt before each text, as sentence-transformers
// does for Venn's embed with prompt_name (venn/server.py:135).
export function embeddingGemmaPrompt(
  prompt: ReaderPrompt,
): EmbeddingModelMiddleware {
  const prefix = PROMPTS[prompt];
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => ({
      ...params,
      values: params.values.map((value) => `${prefix}${value}`),
    }),
  };
}
