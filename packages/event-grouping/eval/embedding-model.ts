import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type EmbeddingModel, cosineSimilarity, embed } from 'ai';

import type { Design } from '../src/index.ts';

// The embedding model of a design on the llama.cpp server at baseURL. The server
// must serve the model that the design was fitted for (ADR 0001): its vector
// of the probe text must be the vector of the round.
export async function embeddingModel(
  baseURL: string,
  design: Pick<Design, 'embeddingModel'>,
): Promise<Exclude<EmbeddingModel, string>> {
  const model = createOpenAICompatible({
    name: 'llama.cpp',
    baseURL,
  }).embeddingModel(design.embeddingModel);
  const probe: { text: string; vector: number[] } = JSON.parse(
    readFileSync(join(import.meta.dirname, 'embedding-probe.json'), 'utf8'),
  );
  const { embedding } = await embed({ model, value: probe.text });
  const agreement = cosineSimilarity(embedding, probe.vector);
  if (agreement < 0.99999)
    throw new Error(
      `${baseURL} does not serve the EmbeddingGemma 2 Q8_0 model of round #3130 (probe cosine ${agreement}).`,
    );
  return model;
}
