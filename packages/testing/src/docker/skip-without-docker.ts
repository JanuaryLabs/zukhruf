import type { Docker } from './docker.ts';

/** How tests treat Docker: `required`, `skip`, or unset to run when Docker answers. */
export const DOCKER_TESTS = 'ZUKHRUF_TESTING_DOCKER';

/**
 * The `skip` option of a test that needs Docker, read from the environment the
 * host passes (`process.env`). With `ZUKHRUF_TESTING_DOCKER=required` it
 * throws when Docker does not answer, so a machine that must run the tests
 * fails instead of skipping them. With `skip` it always skips. Unset, it skips
 * only when Docker does not answer.
 */
export async function skipWithoutDocker(
  docker: Docker,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string | false> {
  const mode = environment[DOCKER_TESTS];
  switch (mode) {
    case 'skip':
      return `${DOCKER_TESTS}=skip`;
    case 'required':
      await docker.command(['info']).catch((cause: unknown) => {
        throw new Error(
          `${DOCKER_TESTS}=required, but Docker does not answer`,
          {
            cause,
          },
        );
      });
      return false;
    case undefined:
    case '':
      return (await docker.isAvailable())
        ? false
        : `needs Docker; set ${DOCKER_TESTS}=required to fail instead of skipping`;
    default:
      throw new Error(`${DOCKER_TESTS} is "required" or "skip", not "${mode}"`);
  }
}
