/**
 * A retriever could not answer, and a search can go on without it, as
 * Elasticsearch's `skip_unavailable` skips a cluster (ADR 0014). A host
 * adapter throws it, or a subclass of it, when its source cannot answer:
 * HTTP 503 or 429, a timeout of its own, a refusal.
 */
export class RetrieverUnavailableError extends Error {
  override readonly name: string = 'RetrieverUnavailableError';
}
