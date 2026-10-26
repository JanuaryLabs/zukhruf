import { globalSetup as startTestRun } from '@zukhruf/testing/docker-global-setup';

import { storeCases } from './store-cases.ts';

export { globalTeardown } from '@zukhruf/testing/docker-global-setup';

/**
 * Makes one fixture of each server store and disposes it: the shared database
 * servers start, and the images arrive, before any test. On a slow runner a
 * server start takes tens of seconds, and the time limit of a test counts
 * only the work of the test. It runs before the test run starts, so the
 * shared servers, which stay for later runs, are not in the run's records.
 */
export async function globalSetup(): Promise<void> {
  await Promise.all(
    storeCases
      .filter((store) => store.reach === 'network')
      .map(async (store) => {
        await using _fixture = await store.fixture(process.env);
      }),
  );
  await startTestRun();
}
