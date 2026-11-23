import { buildkitTrace } from './buildkit-trace.ts';
import type * as EngineApi from './engine-api.ts';
import { BuildFailedError, DockerEngineError } from './errors.ts';
import { ndjson } from './ndjson.ts';

/** The log of a step that a BuildFailedError keeps: its last 64 KiB, a bound of this package. */
const LOG_LIMIT = 64 * 1024;

/** One message of the progress of POST /build (BuildInfo of the Engine API). */
interface BuildMessage {
  id?: string;
  aux?: unknown;
  error?: string;
  errorDetail?: { message?: string };
}

function isBuildMessage(value: unknown): value is BuildMessage {
  return typeof value === 'object' && value !== null;
}

/** A step of the build, by its digest, with its log as it came. */
interface Step {
  name: string;
  error: string;
  log: Uint8Array[];
  size: number;
}

/** Drops the oldest chunks of the log while the rest holds LOG_LIMIT bytes. */
function append(step: Step, msg: Uint8Array): void {
  step.log.push(msg);
  step.size += msg.byteLength;
  while (step.size - step.log[0]!.byteLength >= LOG_LIMIT) {
    step.size -= step.log.shift()!.byteLength;
  }
}

function output(step: Step | undefined): string {
  if (step === undefined) return '';
  const log = Buffer.concat(step.log);
  return new TextDecoder().decode(log.subarray(log.byteLength - LOG_LIMIT));
}

/**
 * Reads the progress of a BuildKit build to its end and gives the ID of the
 * image from the `moby.image.id` message. An error in the progress, after the
 * status 200, is a BuildFailedError with the step that reported an error and
 * its log. No decision reads the text of the error: it differs by engine.
 */
export async function readBuildProgress(
  chunks: AsyncIterable<Uint8Array>,
  request: { method: string; path: string },
): Promise<EngineApi.ImageID> {
  const steps = new Map<string, Step>();
  let image: EngineApi.ImageID | undefined;
  for await (const message of ndjson(chunks)) {
    if (!isBuildMessage(message)) continue;
    const text = message.errorDetail?.message ?? message.error;
    if (text !== undefined) {
      const failed = steps.values().find((step) => step.error !== '');
      throw new BuildFailedError(
        text,
        { status: undefined, request },
        failed?.name,
        output(failed),
      );
    }
    if (
      message.id === 'moby.buildkit.trace' &&
      typeof message.aux === 'string'
    ) {
      const { vertexes, logs } = buildkitTrace(message.aux);
      for (const { digest, name, error } of vertexes) {
        const step = steps.get(digest);
        if (step === undefined) {
          steps.set(digest, { name, error, log: [], size: 0 });
        } else {
          step.name = name || step.name;
          step.error = error || step.error;
        }
      }
      for (const { vertex, msg } of logs) {
        let step = steps.get(vertex);
        if (step === undefined) {
          step = { name: '', error: '', log: [], size: 0 };
          steps.set(vertex, step);
        }
        append(step, msg);
      }
    } else if (message.id === 'moby.image.id') {
      const id: unknown = Reflect.get(Object(message.aux), 'ID');
      if (typeof id === 'string') image = { ID: id };
    }
  }
  if (image === undefined) {
    throw new DockerEngineError(
      'The build ended with no image ID in its progress.',
      { status: undefined, request },
    );
  }
  return image;
}
