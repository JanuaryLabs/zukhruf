import type { Embeddings } from '../../types/encoder-io.ts';

// mteb/models/cache_wrappers/cache_backend_protocol.py: a store that maps the
// content hash of an item to its embedding.
export interface CacheBackendProtocol {
  // Stores the vector of each item. A known item gets its new vector.
  add(items: readonly { readonly text: string }[], vectors: Embeddings): void;
  // The stored vector of the item, or null.
  getVector(item: { readonly text: string }): Float32Array | null;
  // Writes the index and the metadata to disk.
  save(): void;
  // Reads the index and the metadata from disk.
  load(): void;
  close(): void;
  // __contains__.
  has(item: { readonly text: string }): boolean;
}

// MTEB takes the class of a backend and calls it with the folder of the
// cache. A function gives the backend its own arguments too, as
// functools.partial does in Python.
export type CacheBackend = (directory: string) => CacheBackendProtocol;
