import type { ModelName } from './model-identity.ts';

/**
 * The query model of an embedding retriever has another provider or model id
 * than the model that made the stored vectors, so their vectors do not
 * compare (ADR 0010). The retriever finds it before the model call. A query
 * vector of other dimensions is a `DimensionMismatchError` of
 * `@zukhruf/vectors`, after the model call.
 */
export class ModelMismatchError extends Error {
  override readonly name = 'ModelMismatchError';
  readonly stored: ModelName;
  readonly query: ModelName;

  constructor(stored: ModelName, query: ModelName) {
    super(
      `The query model ${query.provider}/${query.modelId} is not the model of the stored vectors, ${stored.provider}/${stored.modelId}`,
    );
    this.stored = stored;
    this.query = query;
  }
}
