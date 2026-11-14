import { readFile } from 'node:fs/promises';

import { SafetensorsHeader } from './safetensors-header.ts';

// A float32 tensor: its shape, and its values in row-major order.
export type Tensor = {
  readonly shape: readonly number[];
  readonly values: Float32Array;
};

// The tensors of a safetensors file of float32 tensors, by name, as Venn's
// runtime.load_weights reads the venn-1 head (venn/runtime.py:35).
export async function loadWeights(path: string): Promise<Map<string, Tensor>> {
  const bytes = await readFile(path);
  const header = SafetensorsHeader.parse(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Map(
    header.tensors.map(({ name, shape, begin, end }) => {
      const values = new Float32Array(
        (end - begin) / Float32Array.BYTES_PER_ELEMENT,
      );
      const start = header.dataStart + begin;
      for (let index = 0; index < values.length; index++)
        values[index] = view.getFloat32(
          start + index * Float32Array.BYTES_PER_ELEMENT,
          true,
        );
      return [name, { shape, values }];
    }),
  );
}
