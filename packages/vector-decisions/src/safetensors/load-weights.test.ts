import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { SafetensorError, type Tensor, loadWeights } from '../index.ts';

type Expected = {
  readonly headerLength: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly tensors: Readonly<
    Record<string, { readonly shape: number[]; readonly bits: string[] }>
  >;
};

// loadWeights refuses the file with the SafetensorError of the package, and
// the message matches.
async function assertRefused(path: string, message: RegExp): Promise<void> {
  await assert.rejects(loadWeights(path), (error: unknown) => {
    assert.ok(error instanceof SafetensorError, String(error));
    assert.match(error.message, message);
    return true;
  });
}

const GOLDEN = join(import.meta.dirname, 'fixtures/golden.safetensors');
const expected: Expected = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/expected.json'), 'utf8'),
);

// The weights equal what safetensors 0.8.0 reads from golden.safetensors:
// the same names, shapes and bits of each float32 value.
function assertGolden(weights: ReadonlyMap<string, Tensor>): void {
  assert.deepEqual(
    [...weights.keys()].toSorted(),
    Object.keys(expected.tensors).toSorted(),
  );
  for (const [name, { shape, bits }] of Object.entries(expected.tensors)) {
    const tensor = weights.get(name);
    assert.ok(tensor, name);
    assert.deepEqual(tensor.shape, shape, name);
    assert.deepEqual(
      Array.from(
        new Uint32Array(
          tensor.values.buffer,
          tensor.values.byteOffset,
          tensor.values.length,
        ),
        (word) => word.toString(16).padStart(8, '0'),
      ),
      bits,
      name,
    );
  }
}

// The header text and the data of golden.safetensors, to write them again
// in another form.
async function goldenParts(): Promise<{
  readonly header: Record<string, unknown>;
  readonly data: Uint8Array;
}> {
  const bytes = await readFile(GOLDEN);
  const start = 8 + expected.headerLength;
  return {
    header: JSON.parse(bytes.subarray(8, start).toString('utf8')),
    data: bytes.subarray(start),
  };
}

type HeaderEntry = {
  readonly dtype: string;
  readonly shape: readonly number[];
  readonly data_offsets: readonly [number, number];
};

// A safetensors file as its format defines it: 8 bytes with the length of
// the header, the header padded with spaces so that the data starts at a
// multiple of 8 bytes, then the data.
function fileBytes(headerText: string, dataLength: number): Uint8Array {
  const padded = headerText.padEnd(
    Math.ceil((headerText.length + 8) / 8) * 8 - 8,
    ' ',
  );
  const bytes = new Uint8Array(8 + padded.length + dataLength);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(padded.length), true);
  bytes.set(new TextEncoder().encode(padded), 8);
  return bytes;
}

function safetensorsBytes(
  header: Readonly<Record<string, HeaderEntry>>,
  dataLength: number,
): Uint8Array {
  return fileBytes(JSON.stringify(header), dataLength);
}

test('a gap between two tensors is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'gap.safetensors');
  await writeFile(
    path,
    safetensorsBytes(
      {
        first: { dtype: 'F32', shape: [2], data_offsets: [0, 8] },
        second: { dtype: 'F32', shape: [2], data_offsets: [12, 20] },
      },
      20,
    ),
  );

  await assertRefused(path, /bytes 8 to 12/);
});

test('bytes after the last tensor are refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'trailing.safetensors');
  await writeFile(
    path,
    safetensorsBytes(
      { only: { dtype: 'F32', shape: [2], data_offsets: [0, 8] } },
      12,
    ),
  );

  await assertRefused(path, /12 bytes of data.*cover 8/);
});

test('two tensors whose bytes overlap are refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'overlap.safetensors');
  await writeFile(
    path,
    safetensorsBytes(
      {
        first: { dtype: 'F32', shape: [2], data_offsets: [0, 8] },
        second: { dtype: 'F32', shape: [2], data_offsets: [4, 12] },
      },
      12,
    ),
  );

  await assertRefused(path, /first and second overlap at bytes 4 to 8/);
});

test('a gap before the first tensor is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'leading-gap.safetensors');
  await writeFile(
    path,
    safetensorsBytes(
      { only: { dtype: 'F32', shape: [2], data_offsets: [4, 12] } },
      12,
    ),
  );

  await assertRefused(path, /gap at bytes 0 to 4, before the tensor only/);
});

test('a byte range that does not fit the shape is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'short-range.safetensors');
  await writeFile(
    path,
    safetensorsBytes(
      { wide: { dtype: 'F32', shape: [3], data_offsets: [0, 8] } },
      8,
    ),
  );

  await assertRefused(
    path,
    /wide has the shape \[3\], so it needs 12 bytes, but its range has 8/,
  );
});

test('a byte range that begins after it ends is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'reversed-range.safetensors');
  await writeFile(
    path,
    safetensorsBytes(
      { reversed: { dtype: 'F32', shape: [], data_offsets: [4, 0] } },
      4,
    ),
  );

  await assertRefused(
    path,
    /reversed begins at byte 4, after its end at byte 0/,
  );
});

test('a byte range past the end of the data is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'past-end.safetensors');
  await writeFile(
    path,
    safetensorsBytes(
      { long: { dtype: 'F32', shape: [2], data_offsets: [0, 8] } },
      4,
    ),
  );

  await assertRefused(
    path,
    /long ends at byte 8, after the end of the data \(4 bytes\)/,
  );
});

test('a header length past the end of the file is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'truncated.safetensors');
  const bytes = new Uint8Array(18);
  new DataView(bytes.buffer).setBigUint64(0, 100n, true);
  await writeFile(path, bytes);

  await assertRefused(
    path,
    /header of 100 bytes, but the file has 10 bytes after its length/,
  );
});

test('a file shorter than the 8 bytes of the length of its header is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'four-bytes.safetensors');
  await writeFile(path, new Uint8Array(4));

  await assertRefused(path, /4 bytes, fewer than the 8 bytes/);
});

test('a header that is not JSON is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'not-json.safetensors');
  await writeFile(path, fileBytes('{"only": {"dtype": "F32",', 0));

  await assertRefused(path, /header is not JSON/);
});

test('a header that is not a JSON object is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'array-header.safetensors');
  await writeFile(path, fileBytes('[]', 0));

  await assertRefused(path, /header starts with "\[", not "\{"/);
});

test('a tensor that is not float32 is refused, though its bytes fit', async () => {
  await assertRefused(
    join(import.meta.dirname, 'fixtures/int32.safetensors'),
    /count has the type I32; only F32 is read/,
  );
});

test('an entry without a list for its shape is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'shape-text.safetensors');
  await writeFile(
    path,
    fileBytes(
      '{"broken": {"dtype": "F32", "shape": "2", "data_offsets": [0, 8]}}',
      8,
    ),
  );

  await assertRefused(path, /broken is not \{ dtype, shape, data_offsets \}/);
});

test('a file of safetensors 0.8.0 gives its tensors bit for bit', async () => {
  assertGolden(await loadWeights(GOLDEN));
});

test('a header that leaves the data at an unaligned byte gives the same tensors', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'unaligned.safetensors');
  const { header, data } = await goldenParts();
  // A header may end with spaces. One space more moves the data off a
  // multiple of 4 bytes when the header alone does not.
  const json = JSON.stringify(header);
  const text = new TextEncoder().encode(
    (8 + json.length) % 4 === 0 ? `${json} ` : json,
  );
  const bytes = new Uint8Array(8 + text.length + data.length);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(text.length), true);
  bytes.set(text, 8);
  bytes.set(data, 8 + text.length);
  await writeFile(path, bytes);

  assertGolden(await loadWeights(path));
});

test('a header in another order than the data gives the same tensors', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'reordered.safetensors');
  const { header, data } = await goldenParts();
  const bytes = fileBytes(
    JSON.stringify(Object.fromEntries(Object.entries(header).toReversed())),
    data.length,
  );
  bytes.set(data, bytes.length - data.length);
  await writeFile(path, bytes);

  assertGolden(await loadWeights(path));
});

test('a byte range longer than the shape needs is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'long-range.safetensors');
  await writeFile(
    path,
    safetensorsBytes(
      { narrow: { dtype: 'F32', shape: [2], data_offsets: [0, 12] } },
      12,
    ),
  );

  await assertRefused(
    path,
    /narrow has the shape \[2\], so it needs 8 bytes, but its range has 12/,
  );
});

test('a shape with a size that is not a whole number from 0 up is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const negative = join(directory.path, 'negative-shape.safetensors');
  const fractional = join(directory.path, 'fractional-shape.safetensors');
  await writeFile(
    negative,
    safetensorsBytes(
      { flipped: { dtype: 'F32', shape: [-1, -2], data_offsets: [0, 8] } },
      8,
    ),
  );
  await writeFile(
    fractional,
    safetensorsBytes(
      { halved: { dtype: 'F32', shape: [0.5, 4], data_offsets: [0, 8] } },
      8,
    ),
  );

  await assertRefused(
    negative,
    /flipped is not \{ dtype, shape, data_offsets \}/,
  );
  await assertRefused(
    fractional,
    /halved is not \{ dtype, shape, data_offsets \}/,
  );
});

test('a negative byte offset is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'negative-offset.safetensors');
  await writeFile(
    path,
    safetensorsBytes(
      { early: { dtype: 'F32', shape: [2], data_offsets: [-4, 4] } },
      4,
    ),
  );

  await assertRefused(path, /early is not \{ dtype, shape, data_offsets \}/);
});

test('byte offsets that are not a pair are refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const path = join(directory.path, 'one-offset.safetensors');
  await writeFile(
    path,
    fileBytes(
      '{"single": {"dtype": "F32", "shape": [], "data_offsets": [0]}}',
      4,
    ),
  );

  await assertRefused(path, /single is not \{ dtype, shape, data_offsets \}/);
});
