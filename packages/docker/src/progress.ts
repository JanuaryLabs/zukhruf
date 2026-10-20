import { DockerEngineError } from './errors.ts';
import { ndjson } from './ndjson.ts';

/** One message of the progress of a pull, a push or a load. */
interface ProgressMessage {
  status?: string;
  error?: string;
  errorDetail?: { message?: string; code?: number };
}

function isProgressMessage(value: unknown): value is ProgressMessage {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads the progress of the engine to its end. The engine reports an error in
 * the progress after the status 200, so the DockerEngineError has no status.
 */
export async function readProgress(
  chunks: AsyncIterable<Uint8Array>,
  request: { method: string; path: string },
): Promise<void> {
  for await (const message of ndjson(chunks)) {
    if (!isProgressMessage(message)) continue;
    const text = message.errorDetail?.message ?? message.error;
    if (text !== undefined) {
      throw new DockerEngineError(text, { status: undefined, request });
    }
  }
}
