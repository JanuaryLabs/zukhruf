import { Docker } from '../index.ts';

export const TEST_LABEL = 'dev.zukhruf.docker.test';
export const IMAGE = 'alpine:3';

/** The engine that the environment of the test run selects, with `image` on it. */
export async function connect(image: string): Promise<Docker> {
  const docker = await Docker.connect({
    clock: globalThis,
    environment: process.env,
    signal: AbortSignal.timeout(15_000),
  });
  if (!(await docker.images.inspect(image))) await docker.images.pull(image);
  return docker;
}

/** Removes each container with the label of this test run, with its anonymous volumes. */
export async function removeLabeled(
  docker: Docker,
  run: string,
): Promise<void> {
  const left = await docker.containers.list({
    all: true,
    filters: { label: [`${TEST_LABEL}=${run}`] },
  });
  for (const summary of left) {
    const container = await docker.containers.find(summary.Id);
    await container?.remove({ force: true, v: true });
  }
}
