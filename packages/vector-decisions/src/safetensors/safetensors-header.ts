import { SafetensorError } from './safetensor-error.ts';

// The bytes of the length of the header, before the header.
const LENGTH_BYTES = 8;

export type TensorEntry = {
  readonly name: string;
  readonly shape: readonly number[];
  // The byte range in the data, from begin up to end.
  readonly begin: number;
  readonly end: number;
};

type RawEntry = {
  readonly dtype: string;
  readonly shape: readonly number[];
  readonly data_offsets: readonly [number, number];
};

// The header of a safetensors file
// (https://github.com/huggingface/safetensors#format): its tensors, and where
// the data starts. `parse` refuses a header that breaks a rule of the format.
export class SafetensorsHeader {
  readonly dataStart: number;
  readonly tensors: readonly TensorEntry[];

  private constructor(dataStart: number, tensors: readonly TensorEntry[]) {
    this.dataStart = dataStart;
    this.tensors = tensors;
  }

  static parse(bytes: Uint8Array): SafetensorsHeader {
    const dataStart = LENGTH_BYTES + SafetensorsHeader.#length(bytes);
    const raw = SafetensorsHeader.#json(
      new TextDecoder().decode(bytes.subarray(LENGTH_BYTES, dataStart)),
    );
    const tensors = Object.entries(raw)
      .filter(([name]) => name !== '__metadata__')
      .map(([name, entry]) => SafetensorsHeader.#entry(name, entry));
    SafetensorsHeader.#checkCoverage(tensors, bytes.byteLength - dataStart);
    return new SafetensorsHeader(dataStart, tensors);
  }

  static #length(bytes: Uint8Array): number {
    if (bytes.byteLength < LENGTH_BYTES)
      throw new SafetensorError(
        `The file has ${bytes.byteLength} bytes, fewer than the ${LENGTH_BYTES} bytes of the length of its header.`,
      );
    const length = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getBigUint64(0, true);
    const after = bytes.byteLength - LENGTH_BYTES;
    if (length > BigInt(after))
      throw new SafetensorError(
        `The file gives a header of ${length} bytes, but the file has ${after} bytes after its length.`,
      );
    return Number(length);
  }

  static #json(text: string): Record<string, unknown> {
    if (!text.startsWith('{'))
      throw new SafetensorError(
        `The header starts with ${JSON.stringify(text.slice(0, 1))}, not "{".`,
      );
    try {
      return JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new SafetensorError(`The header is not JSON: ${error.message}`, {
        cause: error,
      });
    }
  }

  static #entry(name: string, raw: unknown): TensorEntry {
    if (!SafetensorsHeader.#isRawEntry(raw))
      throw new SafetensorError(
        `The tensor ${name} is not { dtype, shape, data_offsets }: ${JSON.stringify(raw)}.`,
      );
    if (raw.dtype !== 'F32')
      throw new SafetensorError(
        `The tensor ${name} has the type ${raw.dtype}; only F32 is read.`,
      );
    const [begin, end] = raw.data_offsets;
    if (begin > end)
      throw new SafetensorError(
        `The tensor ${name} begins at byte ${begin}, after its end at byte ${end}.`,
      );
    const needed =
      raw.shape.reduce((product, size) => product * size, 1) *
      Float32Array.BYTES_PER_ELEMENT;
    if (end - begin !== needed)
      throw new SafetensorError(
        `The tensor ${name} has the shape [${raw.shape.join(', ')}], so it needs ${needed} bytes, but its range has ${end - begin}.`,
      );
    return { name, shape: raw.shape, begin, end };
  }

  static #isRawEntry(raw: unknown): raw is RawEntry {
    if (typeof raw !== 'object' || raw === null) return false;
    const {
      dtype,
      shape,
      data_offsets: offsets,
    } = Object.fromEntries(Object.entries(raw));
    return (
      typeof dtype === 'string' &&
      SafetensorsHeader.#isCounts(shape) &&
      SafetensorsHeader.#isCounts(offsets) &&
      offsets.length === 2
    );
  }

  static #isCounts(value: unknown): value is number[] {
    return (
      Array.isArray(value) &&
      value.every((item) => Number.isSafeInteger(item) && item >= 0)
    );
  }

  // The format forbids holes in the data, so a file cannot hide other content
  // between or after its tensors.
  static #checkCoverage(
    tensors: readonly TensorEntry[],
    dataLength: number,
  ): void {
    // By begin, then by end, as safetensors orders the ranges: an empty
    // tensor at byte b comes before a tensor that starts at b.
    const ordered = tensors.toSorted(
      (a, b) => a.begin - b.begin || a.end - b.end,
    );
    const first = ordered[0];
    if (first !== undefined && first.begin > 0)
      throw new SafetensorError(
        `The data has a gap at bytes 0 to ${first.begin}, before the tensor ${first.name}.`,
      );
    for (const [index, tensor] of ordered.entries()) {
      const next = ordered[index + 1];
      if (next === undefined) continue;
      if (next.begin > tensor.end)
        throw new SafetensorError(
          `The data has a gap at bytes ${tensor.end} to ${next.begin}, between the tensors ${tensor.name} and ${next.name}.`,
        );
      if (next.begin < tensor.end)
        throw new SafetensorError(
          `The tensors ${tensor.name} and ${next.name} overlap at bytes ${next.begin} to ${tensor.end}.`,
        );
    }
    const last = ordered.at(-1);
    if (last !== undefined && last.end > dataLength)
      throw new SafetensorError(
        `The tensor ${last.name} ends at byte ${last.end}, after the end of the data (${dataLength} bytes).`,
      );
    const covered = last?.end ?? 0;
    if (covered < dataLength)
      throw new SafetensorError(
        `The file has ${dataLength} bytes of data, but its tensors cover ${covered}.`,
      );
  }
}
