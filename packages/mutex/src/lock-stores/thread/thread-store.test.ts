import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

import { describe, test } from '@zukhruf/testing/node';

import { Modes } from '../../mutex/acquire-modes/modes.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { isRecord } from '../../shared/is-record.ts';
import { deadlineFor } from '../../testing/contract/deadlines.ts';
import {
  startThread,
  storeIn,
  threadSource,
} from '../../testing/contract/peers.ts';
import { skipperBody } from '../../testing/contract/processes.ts';
import { hold } from '../../testing/hold.ts';
import { newProcessTimeout } from '../../testing/new-process-timeout.ts';
import {
  type ThreadHost,
  threadSharing as sharing,
  subject as store,
} from '../../testing/subjects/thread.ts';
import { settle } from '../../testing/timing.ts';
import { tokensThatFailOnce } from '../../testing/tokens-that-fail-once.ts';
import { ThreadLockCoordinator } from './index.ts';

const mutexUrl = new URL('../../mutex/mutex.ts', import.meta.url);
const modesUrl = new URL('../../mutex/acquire-modes/modes.ts', import.meta.url);

/** The answer a worker thread reports; the thread's lock requests share its port. */
function lookFrom(worker: Worker): Promise<unknown> {
  return new Promise((resolve) => {
    worker.on('message', (message: unknown) => {
      if (isRecord(message) && 'looked' in message) resolve(message.looked);
    });
  });
}

describe(`Cross-thread mutex with ${store.name}`, () => {
  test('a thread waits while another thread of the same process holds the key', async (t) => {
    // Arrange: the main thread holds the key.
    await using fixture = await store.fixture(process.env);
    await using host = store.open(fixture.location);
    const mutex = new Mutex(host.store);
    const finishMain = Promise.withResolvers<void>();
    const held = mutex.acquire('product:42', () => finishMain.promise);
    const events: string[] = [];
    const thread = startThread(
      sharing,
      host,
      threadSource(
        sharing.module,
        fixture.location,
        `parentPort.postMessage('requested');
						 await mutex.acquire('product:42', async () => parentPort.postMessage('entered'));`,
      ),
    );
    thread.on('message', (event) => {
      if (typeof event === 'string') events.push(event);
    });

    try {
      // Act: the thread asks for the same key while the main thread holds it.
      await t.waitFor(
        () => assert.ok(events.includes('requested'), 'The thread must start'),
        { interval: 5, timeout: newProcessTimeout },
      );
      await delay(deadlineFor(store, settle, { grants: 1, releases: 0 }));
      const enteredWhileHeld = events.includes('entered');
      finishMain.resolve();
      await held;

      // Assert
      assert.equal(
        enteredWhileHeld,
        false,
        'The thread entered while the main thread held the key',
      );
      await t.waitFor(
        () =>
          assert.ok(
            events.includes('entered'),
            'The thread must enter once the main thread releases',
          ),
        {
          interval: 5,
          timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
        },
      );
    } finally {
      finishMain.resolve();
      await thread.terminate();
    }
  });

  test('a thread whose only pending work is waiting for the key still gets it', async () => {
    // Arrange: the main thread holds the key, and the worker thread has nothing to do but wait.
    await using fixture = await store.fixture(process.env);
    await using host = store.open(fixture.location);
    const mutex = new Mutex(host.store);
    const release = Promise.withResolvers<void>();
    const held = mutex.acquire('product:42', () => release.promise);
    const thread = startThread(
      sharing,
      host,
      threadSource(
        sharing.module,
        fixture.location,
        `await mutex.acquire('product:42', async () => parentPort.postMessage('entered'));`,
      ),
    );
    const events: string[] = [];
    thread.on('message', (event) => {
      if (typeof event === 'string') events.push(event);
    });
    const exited = once(thread, 'exit');

    try {
      // Act: the key stays held long enough for an idle thread to give up.
      await delay(300);
      release.resolve();
      await held;
      const [code] = await exited;

      // Assert: waiting kept the thread alive until the grant arrived.
      assert.deepEqual(
        { code, events },
        { code: 0, events: ['entered'] },
        'The waiting thread must stay alive, get the key, and then exit normally',
      );
    } finally {
      release.resolve();
      await thread.terminate();
    }
  });

  test('messages of its own and unreadable lock messages from a thread leave its locks working', async (t) => {
    // Arrange: the thread posts its own messages to the main thread, and lock envelopes that hold no request.
    await using fixture = await store.fixture(process.env);
    await using host = store.open(fixture.location);
    const mutex = new Mutex(host.store);
    const thread = startThread(
      sharing,
      host,
      threadSource(
        sharing.module,
        fixture.location,
        `parentPort.postMessage({ type: 'app' });
						 parentPort.postMessage({ '@lock': 42 });
						 parentPort.postMessage({ '@lock': null });
						 parentPort.postMessage({ '@lock': { op: 'acquire' } });
						 await mutex.acquire('product:42', async () => {});
						 parentPort.postMessage('released');`,
      ),
    );
    const events: string[] = [];
    thread.on('message', (event) => {
      if (typeof event === 'string') events.push(event);
    });

    try {
      // Act
      await t.waitFor(
        () =>
          assert.ok(
            events.includes('released'),
            'The thread must take and release the key after its other messages',
          ),
        { interval: 5, timeout: newProcessTimeout },
      );
      // A key that is never handed over keeps this await open until the test times out.
      const next = await mutex.acquire(
        'product:42',
        async () => 'granted' as const,
      );

      // Assert
      assert.equal(
        next,
        'granted',
        'The main thread must get the key the thread released',
      );
    } finally {
      await thread.terminate();
    }
  });

  test('a thread that waits for a key ignores a lock message from the main thread that is not a valid answer', async (t) => {
    // Arrange: the main thread holds the key, and the thread asks for it.
    await using fixture = await store.fixture(process.env);
    await using host = store.open(fixture.location);
    const mutex = new Mutex(host.store);
    const finishMain = Promise.withResolvers<void>();
    const held = mutex.acquire('product:42', () => finishMain.promise);
    const thread = startThread(
      sharing,
      host,
      threadSource(
        sharing.module,
        fixture.location,
        `await mutex.acquire('product:42', async () => parentPort.postMessage('entered'));`,
      ),
    );
    const events: string[] = [];
    let request: string | undefined;
    thread.on('message', (event: unknown) => {
      if (typeof event === 'string') events.push(event);
      const message = isRecord(event) ? event['@lock'] : undefined;
      if (isRecord(message) && typeof message.id === 'string')
        request = message.id;
    });

    try {
      await t.waitFor(
        () =>
          assert.ok(request !== undefined, 'The thread must ask for the key'),
        { interval: 5, timeout: newProcessTimeout },
      );

      // Act: a grant for the thread's request, with a token that no coordinator issues.
      thread.postMessage({
        '@lock': { op: 'granted', id: request, token: 'not-a-token' },
      });
      await delay(deadlineFor(store, settle, { grants: 1, releases: 0 }));
      const enteredBeforeRelease = events.includes('entered');
      finishMain.resolve();
      await held;

      // Assert
      assert.equal(
        enteredBeforeRelease,
        false,
        'The thread entered on a grant that was not valid',
      );
      await t.waitFor(
        () =>
          assert.ok(
            events.includes('entered'),
            'The thread must enter once the main thread releases',
          ),
        {
          interval: 5,
          timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
        },
      );
    } finally {
      finishMain.resolve();
      await thread.terminate();
    }
  });
});

describe(`Holder check across threads with ${store.name}`, () => {
  test('a look from a worker thread sees a holder in this thread', async () => {
    // Arrange: this thread holds the key until the worker has looked.
    await using fixture = await store.fixture(process.env);
    await using host = store.open(fixture.location);
    const mutex = new Mutex(host.store);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holding = mutex.acquire('report:daily', async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;

      // Act
      const looker = startThread(
        sharing,
        host,
        threadSource(
          sharing.module,
          fixture.location,
          `parentPort.postMessage({ looked: await mutex.isHeld('report:daily') });`,
        ),
      );
      const held = await lookFrom(looker);
      await looker.terminate();

      // Assert
      assert.equal(held, true);
    } finally {
      release.resolve();
      await holding;
    }
  });
});

describe(`Acquire modes across threads with ${store.name}`, () => {
  test('a thread that skips or cancels while another thread holds gets no key, and leaves the key free', async () => {
    // Arrange: the main thread holds the key; a worker (kept alive) tries to skip.
    await using fixture = await store.fixture(process.env);
    await using host: ThreadHost = store.open(fixture.location);
    const mutex = new Mutex(host.store);
    const holder = await hold(mutex, 'report:daily');
    const thread = new Worker(
      `
					(async () => {
						const { parentPort } = await import('node:worker_threads');
						const { Mutex } = await import(${JSON.stringify(mutexUrl.href)});
						const { Modes } = await import(${JSON.stringify(modesUrl.href)});
						setInterval(() => {}, 1000);
						const mutex = new Mutex(${storeIn(sharing.module, fixture.location)});
						const report = (message) => parentPort.postMessage(message);
						${skipperBody}
					})();
				`,
      { eval: true },
    );
    sharing.admit(host, thread);
    const results = new Promise<{
      atOnce: unknown;
      afterLimit: unknown;
      cancelled: unknown;
    }>((resolve) =>
      thread.on('message', (message) => {
        if (message?.type === 'results') resolve(message);
      }),
    );

    try {
      // Act
      const reported = await results;
      await holder.release();

      // Assert
      assert.deepEqual(
        {
          atOnce: reported.atOnce,
          afterLimit: reported.afterLimit,
          cancelled: reported.cancelled,
        },
        {
          atOnce: { acquired: false },
          afterLimit: { acquired: false },
          cancelled: 'cancelled',
        },
      );
      assert.equal(
        await mutex.acquire('report:daily', async () => 'next'),
        'next',
        'The key must be free after the holder releases it; the thread that gave up must not keep it',
      );
    } finally {
      await thread.terminate();
    }
  });
});

describe('A worker or child whose token cannot be minted', () => {
  test('a worker thread learns that its acquire failed, takes another key, and that key is free once the thread stops', async () => {
    // Arrange: the parent's token source fails for the first grant.
    const coordinator = new ThreadLockCoordinator({
      tokens: tokensThatFailOnce(
        new Error('The token file could not be written.'),
      ),
    });
    const mutex = new Mutex(coordinator);
    const threadStoreUrl = new URL('./thread-store.ts', import.meta.url);
    const thread = new Worker(
      `
          (async () => {
            const { parentPort } = await import('node:worker_threads');
            const { Mutex } = await import(${JSON.stringify(mutexUrl.href)});
            const { ThreadStore } = await import(${JSON.stringify(threadStoreUrl.href)});
            const mutex = new Mutex(new ThreadStore());
            const failure = await mutex.acquire('product:42', async () => 'granted').then(
              (result) => result,
              (error) => error.name + ': ' + error.message,
            );
            setInterval(() => {}, 1000);
            await mutex.acquire('product:43', async () => {
              parentPort.postMessage({ type: 'holding', failure });
              await new Promise(() => {});
            });
          })();
        `,
      { eval: true },
    );
    coordinator.adopt(thread);

    try {
      // Act: the thread reports while it holds the second key, and then stops.
      // The port also carries the lock messages, so only the report is read.
      const report = new Promise<unknown>((resolve) => {
        thread.on('message', (message) => {
          if (isRecord(message) && message.type === 'holding')
            resolve(message.failure);
        });
      });
      const failure = await Promise.race([
        report,
        delay(newProcessTimeout, 'the thread never reported', {
          ref: false,
        }),
      ]);
      await thread.terminate();
      const next = await mutex.acquire(
        'product:43',
        async () => 'granted' as const,
        { mode: Modes.skipIfBusy({ waitAtMost: 2000, clock: globalThis }) },
      );

      // Assert
      assert.equal(
        failure,
        'GrantFailedError: The lock coordinator could not grant "product:42": The token file could not be written.',
      );
      assert.equal(
        next.acquired,
        true,
        'The key of a thread that stopped must be free',
      );
    } finally {
      await thread.terminate();
    }
  });
});
