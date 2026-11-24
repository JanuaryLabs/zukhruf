import { fileURLToPath } from 'node:url';

import { engine } from './current-engine.ts';

const setup = fileURLToPath(
  new URL('../scripts/docker-global-setup.ts', import.meta.url),
);

/** The URL of this package's Docker library, as source text for a worker of a run. */
export const library = JSON.stringify(
  new URL('../docker/index.ts', import.meta.url).href,
);

/** `node --test` with the Docker global setup. */
export const runnerArgs = (...args: string[]) => [
  '--test',
  `--test-global-setup=${setup}`,
  ...args,
];

/** The environment of a runner that keeps its runs under `state`, on the engine of this process's run. */
export const runEnvironment = (
  state: string,
): Record<string, string | undefined> => ({
  ...process.env,
  // A nested run serves an SSH connection of its own, not this run's docker.sock.
  ...(process.env.DOCKER_HOST !== undefined && { DOCKER_HOST: engine }),
  XDG_STATE_HOME: state,
  // Undefined, not deleted: the object spreads process.env, and Node
  // passes no variable whose value is undefined.
  // A runner launched from a test worker would otherwise skip its files.
  NODE_TEST_CONTEXT: undefined,
  // This test may itself run in a run; a nested run must start its own.
  ZUKHRUF_TESTING_RUN_ID: undefined,
  ZUKHRUF_TESTING_RUN_DIR: undefined,
});
