/**
 * The worker of the global teardown. The teardown must be synchronous, and
 * the Engine API client is asynchronous, so the teardown starts this worker
 * and waits on `signal` until it posts its outcome on `port`.
 */
import { inspect } from 'node:util';
import { type MessagePort, workerData } from 'node:worker_threads';

import type { Run } from './run-cleanup.ts';

/** What the teardown passes to this worker. */
export interface CleanupWork {
  run: Run;
  directory: string;
  port: MessagePort;
  /** One Int32 that this worker sets to 1 after it posted its outcome. */
  signal: SharedArrayBuffer;
}

/** What this worker posts: errors as plain fields, which a port can carry. */
export type CleanupOutcome =
  { ok: true } | { error: { name: string; message: string; detail: string } };

const { run, directory, port, signal }: CleanupWork = workerData;

async function sweep(): Promise<CleanupOutcome> {
  try {
    // Imported here, so that a module that fails to load is an outcome too:
    // the teardown would otherwise wait until its timeout.
    const { connectAndCleanup } = await import('./run-cleanup.ts');
    await connectAndCleanup(run, directory);
    return { ok: true };
  } catch (error) {
    return {
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        detail: inspect(error),
      },
    };
  }
}

port.postMessage(await sweep());
const flag = new Int32Array(signal);
Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);
