import { Transform, type TransformCallback, pipeline } from 'node:stream';

/**
 * Decodes newline-delimited JSON: the bytes in, one value out for each line.
 * A chunk can end inside a line, or inside a UTF-8 character: the line waits
 * for the next chunk. An empty line has no value. A line that is not JSON
 * destroys the stream with the SyntaxError.
 */
export class NdjsonDecoder extends Transform {
  readonly #decoder = new TextDecoder();
  #rest = '';

  constructor() {
    super({ readableObjectMode: true });
  }

  override _transform(
    chunk: Uint8Array,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.#rest += this.#decoder.decode(chunk, { stream: true });
    const lines = this.#rest.split('\n');
    this.#rest = lines.pop() ?? '';
    this.#pushValues(lines, callback);
  }

  override _flush(callback: TransformCallback): void {
    this.#rest += this.#decoder.decode();
    this.#pushValues([this.#rest], callback);
  }

  #pushValues(lines: string[], callback: TransformCallback): void {
    try {
      for (const line of lines) if (line.trim()) this.push(JSON.parse(line));
    } catch (error) {
      callback(Error.isError(error) ? error : new Error(String(error)));
      return;
    }
    callback();
  }
}

/** The values of a stream of newline-delimited JSON, as NdjsonDecoder decodes them. */
export async function* ndjson(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new NdjsonDecoder();
  pipeline(chunks, decoder, () => {});
  yield* decoder;
}
