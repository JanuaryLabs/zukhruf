import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type EmbeddingModel, cosineSimilarity, embed } from 'ai';

import type { Design } from '../src/index.ts';
import { CACHE_FOLDER } from './texts/text-source.ts';

// The environment variable with the OpenAI-compatible base URL of the
// llama.cpp server of a model: EVAL_EMBEDDING_URL_ and the model name in
// capitals, with _ for each other character. For example
// EVAL_EMBEDDING_URL_EMBEDDINGGEMMA_2.
function endpointVariable(model: string): string {
  return `EVAL_EMBEDDING_URL_${model.toUpperCase().replaceAll(/[^A-Z0-9]/gu, '_')}`;
}

// The embedding model of a design, on the server that its variable in the
// environment names.
// The server must serve the model that the design was fitted for: its vector
// of the probe text must be the vector in probes/<model>.json.
export async function embeddingModel(
  design: Pick<Design, 'embeddingModel'>,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<Exclude<EmbeddingModel, string>> {
  const variable = endpointVariable(design.embeddingModel);
  const baseURL = environment[variable];
  if (baseURL === undefined)
    throw new Error(
      `${variable} is not set. Give it the base URL of the llama.cpp server of ${design.embeddingModel} (eval/README.md, "Run it").`,
    );
  const model = createOpenAICompatible({
    name: 'llama.cpp',
    baseURL,
  }).embeddingModel(design.embeddingModel);
  const probe: { text: string; vector: number[] } = JSON.parse(
    readFileSync(
      join(import.meta.dirname, 'probes', `${design.embeddingModel}.json`),
      'utf8',
    ),
  );
  const { embedding } = await embed({ model, value: probe.text });
  const agreement = cosineSimilarity(embedding, probe.vector);
  if (agreement < 0.99999)
    throw new Error(
      `${baseURL} does not serve the ${design.embeddingModel} model of probes/${design.embeddingModel}.json (probe cosine ${agreement}).`,
    );
  return model;
}

// The vector cache of a model for a set. A collection keeps one vector for
// each report, so each model has its own folder.
export function vectorCache(model: string, set: string): string {
  const folder = join(CACHE_FOLDER, 'vectors', model);
  mkdirSync(folder, { recursive: true });
  return join(folder, `${set}.sqlite`);
}
