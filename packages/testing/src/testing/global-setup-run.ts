import { fileURLToPath } from 'node:url';

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

/** The environment of a runner that keeps its runs under `state`. */
export const runEnvironment = (
  state: string,
): Record<string, string | undefined> => ({
  ...process.env,
  XDG_STATE_HOME: state,
  // Undefined, not deleted: nano-spawn adds process.env back, and Node
  // passes no variable whose value is undefined.
  // A runner launched from a test worker would otherwise skip its files.
  NODE_TEST_CONTEXT: undefined,
  // This test may itself run in a run; a nested run must start its own.
  ZUKHRUF_TESTING_RUN_ID: undefined,
  ZUKHRUF_TESTING_RUN_DIR: undefined,
});
