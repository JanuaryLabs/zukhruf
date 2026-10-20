import type { OutputChunk } from './multiplexed-stream.ts';

export interface Output {
  stdout: string;
  stderr: string;
  /** Standard output and standard error, in the order of the engine. */
  output: string;
}

export interface ExecResult extends Output {
  exitCode: number;
}

/**
 * Reads each chunk and decodes the text of each stream. A chunk can end inside
 * a UTF-8 character: the character waits for the next chunk of the same
 * stream, and `output` gets it then, so a chunk of the other stream between
 * the two parts never breaks it. The text is not trimmed.
 */
export async function readOutput(
  chunks: AsyncIterable<OutputChunk>,
): Promise<Output> {
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const text = { stdout: '', stderr: '', output: '' };
  const append = (stream: OutputChunk['stream'], piece: string) => {
    text[stream] += piece;
    text.output += piece;
  };
  for await (const { stream, data } of chunks) {
    append(stream, decoders[stream].decode(data, { stream: true }));
  }
  append('stdout', decoders.stdout.decode());
  append('stderr', decoders.stderr.decode());
  return text;
}
