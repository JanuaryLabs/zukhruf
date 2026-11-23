import type { EmbeddingModel } from 'ai';

/** The provider, the model id and the dimensions of the model that made a vector (ADR 0010). */
export type ModelIdentity = {
  readonly provider: string;
  readonly modelId: string;
  readonly dimensions: number;
};

/**
 * The provider and the model id of a model, which a retriever compares
 * before the model call. An AI SDK embedding model does not state its
 * dimensions, so only its vector shows them.
 */
export type ModelName = Pick<ModelIdentity, 'provider' | 'modelId'>;

/**
 * The form of elt's Embedding rule, `openai/text-embedding-3-small (1536
 * dimensions)`, which the `model` column of the passage vectors holds.
 */
export const describe = ({
  provider,
  modelId,
  dimensions,
}: ModelIdentity): string =>
  `${provider}/${modelId} (${dimensions} dimensions)`;

const storedForm = /^([^/]+)\/(.+) \((\d+) dimensions\)$/;

/** Reads the identity that the `model` column of the passage vectors holds. */
export function parseModelIdentity(text: string): ModelIdentity {
  const [, provider, modelId, dimensions] = storedForm.exec(text) ?? [];
  if (
    provider === undefined ||
    modelId === undefined ||
    dimensions === undefined
  ) {
    throw new TypeError(
      `The stored model ${JSON.stringify(text)} is not a model identity of the form "provider/model (n dimensions)"`,
    );
  }
  return { provider, modelId, dimensions: Number(dimensions) };
}

/**
 * The provider and the model id of a query model, as elt names them: a
 * string model id is `provider/model`, as the AI SDK gateway reads it.
 */
export function modelName(model: EmbeddingModel): ModelName {
  if (typeof model !== 'string') {
    return { provider: model.provider, modelId: model.modelId };
  }
  const [, provider, modelId] = /^([^/]+)\/(.+)$/.exec(model) ?? [];
  if (provider === undefined || modelId === undefined) {
    throw new TypeError(
      `The model id ${JSON.stringify(model)} names no provider: write "provider/model"`,
    );
  }
  return { provider, modelId };
}
