// The port to the vectors of the reports. The detector gives each report with
// a lead to upsert, and asks for its neighbours and similarities. The
// Collection of @zukhruf/embeddings has this shape.
export interface Vectors {
  upsert(
    documents: readonly {
      readonly id: string;
      readonly text: string;
      readonly publishedAt: Date;
    }[],
  ): Promise<void>;
  // The k documents most similar to the document, from those published at
  // most withinDays before or after it, the most similar first.
  nearest(
    id: string,
    options: { readonly k: number; readonly withinDays: number },
  ): readonly { readonly id: string; readonly similarity: number }[];
  // The cosine similarity of two documents.
  similarity(a: string, b: string): number;
}
