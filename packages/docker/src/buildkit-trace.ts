/**
 * The reader of the `moby.buildkit.trace` progress of an image build. Moby
 * sends each BuildKit `StatusResponse` as `proto.Marshal(sr)` in base64, in
 * the `aux` of a line with the `id` `moby.buildkit.trace`
 * (`daemon/internal/builder-next/builder.go` of moby at 8b0c45e42959). This
 * reader decodes the protobuf wire format of the fields that ADR 0016 names,
 * and skips each other field by its wire type.
 *
 * The field numbers are those of `api/services/control/control.proto` of
 * BuildKit at f272b8657b45
 * (https://github.com/moby/buildkit/blob/f272b8657b45/api/services/control/control.proto):
 *
 * - `StatusResponse`: `vertexes` 1 (`Vertex`), `logs` 3 (`VertexLog`).
 * - `Vertex`: `digest` 1, `name` 3, `error` 7 (strings).
 * - `VertexLog`: `vertex` 1 (string), `stream` 3 (int64), `msg` 4 (bytes).
 */

/** A step of the build. As in proto3, a missing string is `''`. */
export interface BuildkitVertex {
  digest: string;
  name: string;
  /** The text of the failure of the step, or `''` if it did not fail. */
  error: string;
}

/** Output that a step wrote. */
export interface BuildkitLog {
  /** The digest of the vertex that wrote it. */
  vertex: string;
  /** The file descriptor: 1 for stdout, 2 for stderr. */
  stream: bigint;
  /** The bytes as the step wrote them; they need not be UTF-8. */
  msg: Uint8Array;
}

export interface BuildkitStatus {
  vertexes: BuildkitVertex[];
  logs: BuildkitLog[];
}

/** Decodes the base64 `aux` of one `moby.buildkit.trace` line. */
export function buildkitTrace(aux: string): BuildkitStatus {
  const bytes = Uint8Array.fromBase64(aux);
  const status: BuildkitStatus = { vertexes: [], logs: [] };
  for (const field of fields(bytes, 0, bytes.length, 'StatusResponse')) {
    if (field.number === 1) {
      status.vertexes.push(vertex(bytes, span(field, 'StatusResponse')));
    } else if (field.number === 3) {
      status.logs.push(log(bytes, span(field, 'StatusResponse')));
    }
  }
  return status;
}

interface Span {
  start: number;
  end: number;
}

type WireField =
  | { number: number; wireType: 0; at: number; varint: bigint }
  | { number: number; wireType: 1 | 2 | 5; at: number; span: Span };

const utf8 = new TextDecoder();

function vertex(bytes: Uint8Array, within: Span): BuildkitVertex {
  const result: BuildkitVertex = { digest: '', name: '', error: '' };
  for (const field of fields(bytes, within.start, within.end, 'Vertex')) {
    const key = ({ 1: 'digest', 3: 'name', 7: 'error' } as const)[field.number];
    if (key) result[key] = text(bytes, span(field, 'Vertex'));
  }
  return result;
}

function log(bytes: Uint8Array, within: Span): BuildkitLog {
  const result: BuildkitLog = { vertex: '', stream: 0n, msg: new Uint8Array() };
  for (const field of fields(bytes, within.start, within.end, 'VertexLog')) {
    if (field.number === 1) {
      result.vertex = text(bytes, span(field, 'VertexLog'));
    } else if (field.number === 3) {
      if (field.wireType !== 0) throw wrongType(field, 0, 'VertexLog');
      result.stream = BigInt.asIntN(64, field.varint);
    } else if (field.number === 4) {
      const { start, end } = span(field, 'VertexLog');
      result.msg = bytes.slice(start, end);
    }
  }
  return result;
}

function text(bytes: Uint8Array, { start, end }: Span): string {
  return utf8.decode(bytes.subarray(start, end));
}

function span(field: WireField, message: string): Span {
  if (field.wireType !== 2) throw wrongType(field, 2, message);
  return field.span;
}

function wrongType(field: WireField, expected: number, message: string) {
  return new Error(
    `BuildKit trace: field ${field.number} of ${message} at byte ${field.at} has wire type ${field.wireType}, not ${expected}`,
  );
}

/** The fields of the message in `bytes` from `start` to `end`. */
function* fields(
  bytes: Uint8Array,
  start: number,
  end: number,
  message: string,
): Generator<WireField> {
  let at = start;
  const fail = (what: string, offset: number) =>
    new Error(`BuildKit trace: ${message} ${what} at byte ${offset}`);
  const varint = (): bigint => {
    const begin = at;
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (at >= end) throw fail('ends inside a varint', begin);
      const byte = bytes[at++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return BigInt.asUintN(64, value);
    }
    throw fail('has a varint longer than 10 bytes', begin);
  };
  const take = (length: number, offset: number): Span => {
    if (length > end - at) {
      throw fail(`ends inside a field of ${length} bytes`, offset);
    }
    const taken = { start: at, end: at + length };
    at += length;
    return taken;
  };
  while (at < end) {
    const fieldAt = at;
    const key = varint();
    const number = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (number === 0) throw fail('has field number 0', fieldAt);
    if (wireType === 0) {
      yield { number, wireType, at: fieldAt, varint: varint() };
    } else if (wireType === 1 || wireType === 5) {
      yield {
        number,
        wireType,
        at: fieldAt,
        span: take(wireType === 1 ? 8 : 4, fieldAt),
      };
    } else if (wireType === 2) {
      const length = Number(varint());
      yield { number, wireType, at: fieldAt, span: take(length, fieldAt) };
    } else {
      throw fail(`has wire type ${wireType}`, fieldAt);
    }
  }
}
