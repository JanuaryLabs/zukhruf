import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildkitTrace } from './buildkit-trace.ts';

describe('buildkitTrace', () => {
  test('a failed RUN of Engine 29.9.3 gives the name and error of its vertex and its output', () => {
    // The last two moby.buildkit.trace lines of the build of
    // `FROM alpine:3.20.3` + `RUN echo some-output; exit 3` on Engine 29.9.3.
    const logLine =
      'GmcKR3NoYTI1NjplMzgyZjQ2NmI5MDMzYmRmZDhkYmIwNzAyYjBjYWIwODg4MDJkMTc3ZTc0ZWEyOWNjMzIxMGEzOGRjMjYxYTY0EgwIxZOS2AYQheTHhwMYASIMc29tZS1vdXRwdXQK';
    const vertexLine =
      'Cq0CCkdzaGEyNTY6ZTM4MmY0NjZiOTAzM2JkZmQ4ZGJiMDcwMmIwY2FiMDg4ODAyZDE3N2U3NGVhMjljYzMyMTBhMzhkYzI2MWE2NBJHc2hhMjU2OmQxNjE5NDM3NWJjMzJmZjE2NDY4YTA2OGE0OGViODk3ODhiMGE0M2UzZmIxOWZhMzRkMmVhNDMwZDdhY2ZjN2UaIlsyLzJdIFJVTiBlY2hvIHNvbWUtb3V0cHV0OyBleGl0IDMqDAjFk5LYBhCBmuPQAjIMCMWTktgGEPyf+I4DOllwcm9jZXNzICIvYmluL3NoIC1jIGVjaG8gc29tZS1vdXRwdXQ7IGV4aXQgMyIgZGlkIG5vdCBjb21wbGV0ZSBzdWNjZXNzZnVsbHk6IGV4aXQgY29kZTogMw==';
    const digest =
      'sha256:e382f466b9033bdfd8dbb0702b0cab088802d177e74ea29cc3210a38dc261a64';

    const log = buildkitTrace(logLine);
    const failed = buildkitTrace(vertexLine);

    assert.deepEqual(log, {
      vertexes: [],
      logs: [
        {
          vertex: digest,
          stream: 1n,
          msg: new TextEncoder().encode('some-output\n'),
        },
      ],
    });
    assert.deepEqual(failed, {
      vertexes: [
        {
          digest,
          name: '[2/2] RUN echo some-output; exit 3',
          error:
            'process "/bin/sh -c echo some-output; exit 3" did not complete successfully: exit code: 3',
        },
      ],
      logs: [],
    });
  });

  test('a stream above 2^53 keeps its exact value', () => {
    // logs { stream: 9007199254740993 }, as protobufjs 8.8.1 encodes it.
    const aux = Uint8Array.fromHex('1a09188180808080808010').toBase64();

    const { logs } = buildkitTrace(aux);

    assert.equal(logs[0]?.stream, 9007199254740993n);
  });

  test('a log that is not UTF-8 keeps its bytes', () => {
    // logs { msg: ff fe 41 }
    const aux = Uint8Array.fromHex('1a052203fffe41').toBase64();

    const { logs } = buildkitTrace(aux);

    assert.deepEqual(logs[0]?.msg, Uint8Array.of(0xff, 0xfe, 0x41));
  });

  test('fields that BuildKit does not define, of each wire type, are skipped', () => {
    // Encoded with protobufjs 8.8.1: the response, its vertex and its log each
    // have field 20 fixed64, 21 fixed32, 22 varint 2^64-1 and 23 bytes; the
    // response also has a status (field 2).
    const aux =
      'oQHLBPtxHwEAAK0BBwAAALAB////////////AboBAwECAwo5CglzaGEyNTY6YWGhAcsE+3EfAQAArQEHAAAAsAH///////////8BugEDAQIDGgRzdGVwOgRib29tEgMKAXgaO6EBywT7cR8BAACtAQcAAACwAf///////////wG6AQMBAgMKCXNoYTI1NjphYRiBgICAgICAECID//5B';

    const status = buildkitTrace(aux);

    assert.deepEqual(status, {
      vertexes: [{ digest: 'sha256:aa', name: 'step', error: 'boom' }],
      logs: [
        {
          vertex: 'sha256:aa',
          stream: 9007199254740993n,
          msg: Uint8Array.of(0xff, 0xfe, 0x41),
        },
      ],
    });
  });

  test('a message cut inside a field throws and says where', () => {
    // logs { stream: 1, msg: "ab" } without its last byte.
    const aux = Uint8Array.fromHex('1a061801220261').toBase64();

    assert.throws(() => buildkitTrace(aux), {
      message:
        'BuildKit trace: StatusResponse ends inside a field of 6 bytes at byte 0',
    });
  });

  test('a message cut inside a varint throws and says where', () => {
    // logs { stream: 2^7 } with the last byte of the varint cut; the log
    // ends where the response ends.
    const aux = Uint8Array.fromHex('1a021880').toBase64();

    assert.throws(() => buildkitTrace(aux), {
      message: 'BuildKit trace: VertexLog ends inside a varint at byte 3',
    });
  });

  test('a field longer than the log that holds it throws, though the response goes on', () => {
    // logs (3 bytes) { msg: 5 bytes }, then three empty vertexes.
    const aux = Uint8Array.fromHex('1a032205610a000a000a00').toBase64();

    assert.throws(() => buildkitTrace(aux), {
      message:
        'BuildKit trace: VertexLog ends inside a field of 5 bytes at byte 2',
    });
  });

  test('a varint cut at the end of the log that holds it throws, though the response goes on', () => {
    // logs (2 bytes) { stream: a varint with no last byte }, then two empty
    // vertexes.
    const aux = Uint8Array.fromHex('1a0218800a000a00').toBase64();

    assert.throws(() => buildkitTrace(aux), {
      message: 'BuildKit trace: VertexLog ends inside a varint at byte 3',
    });
  });

  test('a negative stream keeps its sign', () => {
    // logs { stream: -1 }: a varint of 10 bytes, as int64 encodes it.
    const aux = Uint8Array.fromHex('1a0b18ffffffffffffffffff01').toBase64();

    const { logs } = buildkitTrace(aux);

    assert.equal(logs[0]?.stream, -1n);
  });

  test('a string field with a varint throws and says where', () => {
    // vertexes { digest: the varint 1 }
    const aux = Uint8Array.fromHex('0a020801').toBase64();

    assert.throws(() => buildkitTrace(aux), {
      message:
        'BuildKit trace: field 1 of Vertex at byte 2 has wire type 0, not 2',
    });
  });

  test('a stream with bytes throws and says where', () => {
    // logs { stream: the bytes 00 }
    const aux = Uint8Array.fromHex('1a031a0100').toBase64();

    assert.throws(() => buildkitTrace(aux), {
      message:
        'BuildKit trace: field 3 of VertexLog at byte 2 has wire type 2, not 0',
    });
  });

  test('field number 0 throws and says where', () => {
    const aux = Uint8Array.fromHex('0001').toBase64();

    assert.throws(() => buildkitTrace(aux), {
      message: 'BuildKit trace: StatusResponse has field number 0 at byte 0',
    });
  });

  test('a group, wire type 3 or 4, throws and says where', () => {
    // The start and the end of a group of field 1, which proto3 never writes.
    const start = Uint8Array.fromHex('0b').toBase64();
    const end = Uint8Array.fromHex('0c').toBase64();

    assert.throws(() => buildkitTrace(start), {
      message: 'BuildKit trace: StatusResponse has wire type 3 at byte 0',
    });
    assert.throws(() => buildkitTrace(end), {
      message: 'BuildKit trace: StatusResponse has wire type 4 at byte 0',
    });
  });

  test('a varint longer than 10 bytes throws and says where', () => {
    // Field 1 as a varint of 11 bytes.
    const aux = Uint8Array.fromHex('08ffffffffffffffffffff01').toBase64();

    assert.throws(() => buildkitTrace(aux), {
      message:
        'BuildKit trace: StatusResponse has a varint longer than 10 bytes at byte 1',
    });
  });
});
