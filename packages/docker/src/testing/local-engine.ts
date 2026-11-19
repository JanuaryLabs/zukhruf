import { selectEngine } from '../context-store.ts';
import type { Environment } from '../index.ts';

/**
 * The socket of the engine that the run selects, as `Docker.connect` selects
 * it (DOCKER_HOST, then DOCKER_CONTEXT, then config.json), when that engine
 * is a local unix:// host. Undefined when it is not, as on a run on an SSH
 * engine: a test that needs the local engine skips there.
 */
export async function localEngineSocket(
  environment: Environment,
): Promise<string | undefined> {
  const { host } = await selectEngine({ environment });
  return host.startsWith('unix://') ? host.slice('unix://'.length) : undefined;
}

/** The `skip` option of a test that needs the local engine of the run. */
export function skipWithoutLocalEngine(
  engineSocket: string | undefined,
): string | false {
  return engineSocket === undefined
    ? 'the engine of the run is not a local unix:// engine'
    : false;
}
