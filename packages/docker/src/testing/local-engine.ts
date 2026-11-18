import { Docker, type DockerContext, type Environment } from '../index.ts';

/**
 * The socket of the local engine: the host of the context that the
 * environment selects (DOCKER_HOST, then DOCKER_CONTEXT, then config.json),
 * when it is a unix:// host, so a test reaches the engine that `connect()` of
 * the run reaches. When the selected engine is not a unix:// host, as on a
 * run on an SSH engine, it is the host of the context that config.json makes
 * current, so such a run still finds the engine of this machine. Undefined
 * when neither is a unix:// host.
 */
export async function localEngineSocket(
  environment: Environment,
): Promise<string | undefined> {
  return (
    unixSocketOfCurrent(await Docker.contexts({ environment })) ??
    unixSocketOfCurrent(await Docker.contexts())
  );
}

function unixSocketOfCurrent(contexts: DockerContext[]): string | undefined {
  const current = contexts.find((context) => context.current);
  return current?.host.startsWith('unix://')
    ? current.host.slice('unix://'.length)
    : undefined;
}
