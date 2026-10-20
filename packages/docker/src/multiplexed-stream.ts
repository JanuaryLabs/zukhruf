import { DockerError } from './errors.ts';

/** One piece of output of a container process: its stream and its bytes. */
export interface OutputChunk {
  stream: 'stdout' | 'stderr';
  data: Uint8Array;
}

/** The media type of the output of a container that has no TTY. */
const MULTIPLEXED_STREAM = 'application/vnd.docker.multiplexed-stream';

/** The length of the header of a frame: the stream, three zero bytes, and the length, big-endian. */
const HEADER_LENGTH = 8;

/**
 * The stream of a frame. The engine marks the input of a TTY as stdin (0),
 * and stdcopy of Moby writes it to standard output; 3 is an error of the
 * engine in the stream.
 */
function streamOf(marker: number): 'stdout' | 'stderr' | 'error' {
  if (marker === 0 || marker === 1) return 'stdout';
  if (marker === 2) return 'stderr';
  return 'error';
}

/**
 * The frames of a multiplexed stream as output chunks. A frame can span chunk
 * borders: the part of a frame that a chunk has comes as its own output chunk,
 * so a large frame never waits in memory. The bytes are read at the pace of
 * the caller.
 */
async function* frames(
  bytes: AsyncIterable<Uint8Array>,
): AsyncGenerator<OutputChunk> {
  let header: Uint8Array = new Uint8Array(0);
  let stream: 'stdout' | 'stderr' | 'error' = 'stdout';
  let remaining = 0;
  let error = '';
  const decoder = new TextDecoder();
  for await (const chunk of bytes) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (remaining === 0) {
        const needed = HEADER_LENGTH - header.byteLength;
        const part = chunk.subarray(offset, offset + needed);
        header = concat(header, part);
        offset += part.byteLength;
        if (header.byteLength < HEADER_LENGTH) break;
        const view = new DataView(header.buffer, header.byteOffset);
        stream = streamOf(view.getUint8(0));
        remaining = view.getUint32(4);
        header = new Uint8Array(0);
        continue;
      }
      const data = chunk.subarray(offset, offset + remaining);
      offset += data.byteLength;
      remaining -= data.byteLength;
      if (stream === 'error') {
        error += decoder.decode(data, { stream: remaining > 0 });
        if (remaining === 0) throw new DockerError(error);
      } else {
        yield { stream, data };
      }
    }
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
}

/** A raw stream has no frames: each chunk is standard output. */
async function* raw(
  bytes: AsyncIterable<Uint8Array>,
): AsyncGenerator<OutputChunk> {
  for await (const data of bytes) {
    if (data.byteLength > 0) yield { stream: 'stdout', data };
  }
}

/**
 * The output chunks of a multiplexed stream or of a raw stream, as the
 * Content-Type of the answer names it.
 */
export function outputChunks(
  bytes: AsyncIterable<Uint8Array>,
  contentType: string,
): AsyncGenerator<OutputChunk> {
  const mediaType = contentType.split(';')[0]?.trim();
  return mediaType === MULTIPLEXED_STREAM ? frames(bytes) : raw(bytes);
}
