import assert from 'node:assert/strict';
import { test } from 'node:test';

import { waitFor } from '../async/index.ts';
import { startWorker } from './index.ts';

test('next rejects with the stderr of a child that closes before it sends the message', async (t) => {
  // Arrange
  await using worker = startWorker(
    `console.error('no database'); process.exit(3);`,
    'worker',
  );

  // Act
  const next = worker.next('ready', { signal: t.signal });

  // Assert
  await assert.rejects(next, (error: Error) => {
    assert.match(error.message, /worker closed with .*"code":3.* 'ready'/);
    assert.match(error.message, /worker: no database/);
    return true;
  });
});

test('next rejects with the reason of the signal when it aborts first', async () => {
  // Arrange: the child sends nothing.
  await using worker = startWorker(`setInterval(() => {}, 1_000);`, 'worker');
  const limit = new AbortController();

  // Act
  const next = worker.next('ready', { signal: limit.signal });
  limit.abort();

  // Assert
  await assert.rejects(next, (error) => error === limit.signal.reason);
});

test('next resolves with a message that the child sent before the call', async (t) => {
  // Arrange
  await using worker = startWorker(
    `process.send({ type: 'ready', port: 5432 }); process.disconnect();`,
    'worker',
  );
  await worker.closed;

  // Act
  const ready = await worker.next('ready', { signal: t.signal });

  // Assert
  assert.deepEqual(ready, { type: 'ready', port: 5432 });
});

test('next resolves with the first later message that the predicate selects', async (t) => {
  // Arrange: the child answers three calls when the parent asks.
  await using worker = startWorker(
    `
      process.once('message', () => {
        for (const call of [1, 2, 3]) process.send({ type: 'answer', call });
      });
    `,
    'worker',
  );

  // Act
  const answer = worker.next(
    (message) => message.type === 'answer' && message.call === 2,
    { signal: t.signal },
  );
  worker.child.send('go');

  // Assert
  assert.deepEqual(await answer, { type: 'answer', call: 2 });
});

test('a predicate sees each message once, in order, so it can count', async (t) => {
  // Arrange: two roles arrive before the call, two after it.
  await using worker = startWorker(
    `
      process.send({ type: 'role', term: 1 });
      process.send({ type: 'role', term: 2 });
      process.once('message', () => {
        process.send({ type: 'role', term: 3 });
        process.send({ type: 'role', term: 4 });
      });
    `,
    'worker',
  );
  await worker.next(
    (message) => message.type === 'role' && message.term === 2,
    {
      signal: t.signal,
    },
  );

  // Act
  const seen: unknown[] = [];
  let roles = 0;
  const third = worker.next(
    (message) => {
      seen.push(message.term);
      return message.type === 'role' && ++roles === 3;
    },
    { signal: t.signal },
  );
  worker.child.send('go');

  // Assert
  assert.deepEqual(await third, { type: 'role', term: 3 });
  assert.deepEqual(seen, [1, 2, 3]);
});

test('a worker exits when the process that started it is killed', async (t) => {
  // Arrange: a parent process starts a worker that runs until it is ended.
  const area = import.meta.resolve('./index.ts');
  await using parent = startWorker(
    `
      import { startWorker } from ${JSON.stringify(area)};

      const worker = startWorker('process.send({ type: "running" }); setInterval(() => {}, 1_000);', 'grandchild');
      worker.child.once('message', () => process.send({ type: 'running', pid: worker.child.pid }));
    `,
    'parent',
  );
  const running = await parent.next('running', { signal: t.signal });
  const pid = Number(running.pid);

  // Act
  parent.child.kill('SIGKILL');
  await parent.closed;

  // Assert: the OS ends the worker's stdin, and the worker exits.
  await waitFor(
    () => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }),
    { signal: t.signal },
  );
});
