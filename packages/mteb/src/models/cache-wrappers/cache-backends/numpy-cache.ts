import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { hashItem } from '../../../content-hashes.ts';
import {
  pythonStrRepr,
  pythonStrip,
  zipStrictMismatch,
} from '../../../dependencies/python.ts';
import { pythonJsonDumps } from '../../../results/json.ts';
import type { Embeddings } from '../../../types/encoder-io.ts';
import type { CacheBackendProtocol } from '../cache-backend-protocol.ts';

// mteb/models/cache_wrappers/cache_backends/numpy_cache.py. A folder holds
// three files, which MTEB and this package read and write alike:
// - vectors.npy: the rows of a float32 np.memmap, in the byte order of the
//   machine, with no NPY header. It starts with initialVectors rows and
//   doubles when a row does not fit; the rows that hold no vector are zero.
// - index.json: the row of each content hash, in the order of the rows.
// - dimension: the length of a vector.
// MTEB's warnings are logging, which this package does not port.

const FLOAT32_BYTES = 4;

const IndexFile = z.record(z.string(), z.number().int());

// The open vectors file in place of the memmap, and the shape of the memmap.
type VectorsFile = {
  readonly fd: number;
  rows: number;
  readonly dimension: number;
};

export class NumpyCache implements CacheBackendProtocol {
  readonly directory: string;
  readonly vectorsFile: string;
  readonly indexFile: string;
  readonly dimensionFile: string;
  readonly initialVectors: number;
  hashToIndex = new Map<string, number>();
  vectorDim: number | null = null;
  #vectors: VectorsFile | null = null;

  constructor(directory: string, initialVectors = 100_000) {
    this.directory = directory;
    mkdirSync(this.directory, { recursive: true });
    this.vectorsFile = join(this.directory, 'vectors.npy');
    this.indexFile = join(this.directory, 'index.json');
    this.dimensionFile = join(this.directory, 'dimension');
    this.initialVectors = initialVectors;
  }

  add(items: readonly { readonly text: string }[], vectors: Embeddings): void {
    if (this.vectorDim === null) {
      // Embeddings without a row hold no dimension. MTEB reads it from the
      // shape of the array, which has one also when it has no row.
      const [first] = vectors;
      if (first === undefined) return;
      this.vectorDim = first.length;
      this.#initializeVectorsFile(this.vectorDim);
      this.#saveDimension();
    }
    const file = this.#vectors;
    if (file === null)
      throw new Error(
        'Vectors file not initialized. Call _initialize_vectors_file() first.',
      );
    // zip(items, vectors, strict=True) raises only when it reaches the end of
    // the shorter one, after the pairs before it.
    for (const [position, vector] of vectors.entries()) {
      const item = items[position];
      if (item === undefined) break;
      const itemHash = hashItem(item);
      let index = this.hashToIndex.get(itemHash);
      if (index === undefined) {
        index = this.hashToIndex.size;
        if (index >= file.rows) this.#doubleVectorsFile(file);
        this.hashToIndex.set(itemHash, index);
      }
      this.#write(file, index, vector);
    }
    const mismatch = zipStrictMismatch([items.length, vectors.length]);
    if (mismatch !== null) throw new Error(mismatch);
  }

  // self.vectors[index] = vec. numpy also broadcasts a vector of length 1
  // into the row; an embedding never has length 1.
  #write(file: VectorsFile, index: number, vector: Float32Array): void {
    const { dimension } = file;
    if (vector.length !== dimension)
      throw new RangeError(
        `could not broadcast input array from shape (${vector.length},) into shape (${dimension},)`,
      );
    const bytes = new Uint8Array(
      vector.buffer,
      vector.byteOffset,
      vector.byteLength,
    );
    writeSync(
      file.fd,
      bytes,
      0,
      bytes.length,
      index * dimension * FLOAT32_BYTES,
    );
  }

  #initializeVectorsFile(dimension: number): void {
    if (!existsSync(this.vectorsFile)) {
      const fd = openSync(this.vectorsFile, 'w+');
      ftruncateSync(fd, this.initialVectors * dimension * FLOAT32_BYTES);
      this.#vectors = { fd, rows: this.initialVectors, dimension };
    } else this.#vectors = this.#openVectorsFile(dimension);
  }

  // np.memmap does not infer the number of rows: the size of the file gives
  // it.
  #openVectorsFile(dimension: number): VectorsFile {
    const fd = openSync(this.vectorsFile, 'r+');
    const rows = Math.floor(fstatSync(fd).size / (FLOAT32_BYTES * dimension));
    return { fd, rows, dimension };
  }

  // A memmap of twice the rows over the same file makes the file longer;
  // the new rows are zero.
  #doubleVectorsFile(file: VectorsFile): void {
    file.rows *= 2;
    ftruncateSync(file.fd, file.rows * file.dimension * FLOAT32_BYTES);
  }

  // str(self.vector_dim): Python writes None when no vector has set it.
  #saveDimension(): void {
    writeFileSync(
      this.dimensionFile,
      this.vectorDim === null ? 'None' : String(this.vectorDim),
      'utf8',
    );
  }

  #loadDimension(): void {
    if (!existsSync(this.dimensionFile)) return;
    const text = pythonStrip(readFileSync(this.dimensionFile, 'utf8'));
    if (!/^[+-]?\d+$/.test(text))
      throw new Error(
        `invalid literal for int() with base 10: ${pythonStrRepr(text)}`,
      );
    this.vectorDim = Number(text);
  }

  // The vectors file needs no flush: each row went to the file when add
  // wrote it. index.json goes to a temporary file first, so that a crash
  // leaves the last index whole; its bytes are those of json.dump.
  save(): void {
    const temporary = `${this.indexFile}.tmp`;
    writeFileSync(
      temporary,
      pythonJsonDumps(this.hashToIndex, { indent: 2 }),
      'utf8',
    );
    renameSync(temporary, this.indexFile);
    this.#saveDimension();
  }

  load(): void {
    this.#loadDimension();
    if (!existsSync(this.indexFile) || !existsSync(this.vectorsFile)) return;
    this.hashToIndex = new Map(
      Object.entries(
        IndexFile.parse(JSON.parse(readFileSync(this.indexFile, 'utf8'))),
      ),
    );
    if (this.vectorDim === null) return;
    this.close();
    this.#vectors = this.#openVectorsFile(this.vectorDim);
  }

  getVector(item: { readonly text: string }): Float32Array | null {
    const file = this.#vectors;
    if (file === null) return null;
    const index = this.hashToIndex.get(hashItem(item));
    if (index === undefined) return null;
    if (index >= file.rows)
      throw new Error(
        `index ${index} is out of bounds for axis 0 with size ${file.rows}`,
      );
    const { dimension } = file;
    const vector = new Float32Array(dimension);
    readSync(
      file.fd,
      new Uint8Array(vector.buffer),
      0,
      vector.byteLength,
      index * dimension * FLOAT32_BYTES,
    );
    return vector;
  }

  has(item: { readonly text: string }): boolean {
    return this.hashToIndex.has(hashItem(item));
  }

  close(): void {
    if (this.#vectors === null) return;
    closeSync(this.#vectors.fd);
    this.#vectors = null;
  }
}
