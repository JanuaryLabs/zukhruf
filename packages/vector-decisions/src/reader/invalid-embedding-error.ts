// The model gave a vector that is not finite, or not one vector of the same
// length for each text. Venn refuses it with invalid_embedding
// (venn/server.py:271).
export class InvalidEmbeddingError extends Error {
  constructor(reason: string) {
    super(`The model gave an invalid embedding: ${reason}.`);
    this.name = 'InvalidEmbeddingError';
  }
}
