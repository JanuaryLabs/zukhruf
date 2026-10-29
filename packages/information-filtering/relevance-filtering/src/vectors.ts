export type Similarity = { readonly id: string; readonly similarity: number };

// The port to the vectors of the articles. The filter asks for the similarity
// of the description to each article of a date range, and for the vectors of
// the taught articles. The Collection of @zukhruf/embeddings has this shape.
export interface Vectors {
  // The similarity of the vector to each article published from `from` to
  // `to`, the edges included.
  query(
    vector: readonly number[],
    options: { readonly from: Date; readonly to: Date },
  ): readonly Similarity[];
  // The stored unit vector of each id. An unknown id fails the call.
  fetch(ids: readonly string[]): ReadonlyMap<string, ArrayLike<number>>;
}
