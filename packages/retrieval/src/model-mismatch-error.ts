type ModelIdentity = {
  readonly provider: string;
  readonly modelId: string;
  readonly dimensions: number;
};

/**
 * The query model of an embedding retriever has another model identity than
 * the model that made the stored vectors, so their vectors do not compare
 * (ADR 0010).
 */
export class ModelMismatchError extends Error {
  override readonly name = 'ModelMismatchError';
  readonly stored: ModelIdentity;
  readonly query: ModelIdentity;

  constructor(stored: ModelIdentity, query: ModelIdentity) {
    super(
      `The query model ${describe(query)} is not the model of the stored vectors, ${describe(stored)}`,
    );
    this.stored = stored;
    this.query = query;
  }
}

/** The form of elt's Embedding rule: `openai/text-embedding-3-small (1536 dimensions)`. */
const describe = ({ provider, modelId, dimensions }: ModelIdentity): string =>
  `${provider}/${modelId} (${dimensions} dimensions)`;
