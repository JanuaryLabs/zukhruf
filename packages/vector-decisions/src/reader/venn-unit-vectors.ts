import type { EmbeddingModelMiddleware } from 'ai';

import { float32Norm } from '../unit-vectors/float32-norm.ts';
import { InvalidEmbeddingError } from './invalid-embedding-error.ts';

// The smallest norm that Venn divides by (venn/reader.py unit).
const NORM_EPSILON = 1e-12;

// Gives the vectors of the model as Venn's DecisionService.embed gives them
// (venn/server.py:135): each one normalized in float64 and rounded to float16,
// as Venn stores it (venn/server.py:275), then divided by its norm in float32
// (venn/server.py:163). A vector that is not finite, or a result that is not
// one vector of the same length for each text, throws.
export function vennUnitVectors(): EmbeddingModelMiddleware {
  return {
    specificationVersion: 'v4',
    wrapEmbed: async ({ doEmbed, params }) => {
      const result = await doEmbed();
      check(result.embeddings, params.values.length);
      return { ...result, embeddings: result.embeddings.map(unitVector) };
    },
  };
}

function check(embeddings: readonly (readonly number[])[], count: number) {
  if (embeddings.length !== count)
    throw new InvalidEmbeddingError(
      `${embeddings.length} vectors for ${count} texts`,
    );
  const width = embeddings[0]?.length;
  for (const vector of embeddings) {
    if (vector.length !== width)
      throw new InvalidEmbeddingError(
        `vectors of ${width} and of ${vector.length} numbers`,
      );
    if (!vector.every(Number.isFinite))
      throw new InvalidEmbeddingError('a value that is not finite');
  }
}

function unitVector(vector: readonly number[]): number[] {
  const norm64 = Math.max(Math.hypot(...vector), NORM_EPSILON);
  const float16 = vector.map((value) => Math.f16round(value / norm64));
  const norm = Math.max(float32Norm(float16), NORM_EPSILON);
  return float16.map((value) => Math.fround(value / norm));
}
