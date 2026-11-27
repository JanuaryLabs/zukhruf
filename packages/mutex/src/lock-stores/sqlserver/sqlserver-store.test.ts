import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import type { Clock } from '@zukhruf/async';
import { test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';

import { LeaseLostError } from '../../index.ts';
import { uniqueKey } from '../../testing/contract/keys.ts';
import { type Server, serverAt } from '../../testing/subjects/server.ts';
import {
  sqlServerFixture,
  sqlServerSession,
  sqlServerStoreOn,
} from '../../testing/subjects/sqlserver.ts';
import {
  type SqlServerSession,
  SqlServerStore,
  leaseName,
} from './sqlserver-store.ts';

/**
 * The first tests are the contract of a lock store. Each test after them is a
 * design error that a probe of SQL Server found, or a rule of the lease (ADR
 * 0035). The name of the test says what the wrong design broke.
 */

const heartbeatInterval = 200;
const leaseDuration = 1_000;

/** A store over the fixture's database whose heartbeat and tries run on `clock`. */
const storeOver = (server: Server, clock: Clock = globalThis) =>
  sqlServerStoreOn(() => sqlServerSession(server), {
    heartbeatInterval,
    leaseDuration,
    clock,
  });

/** Runs `text` on a session of the test, not of a store. */
async function observe(
  server: Server,
  text: string,
  parameters: Record<string, string> = {},
) {
  const session = await sqlServerSession(server);
  try {
    return await session.query(text, parameters);
  } finally {
    session.close();
  }
}

/**
 * A holder whose heartbeat runs on a clock that the test never moves, so it
 * never renews, and a store on the real clock that takes the key once the
 * lease ended.
 */
async function takenOver(server: Server, signal: AbortSignal) {
  const clock = createClock();
  const key = uniqueKey();
  const held = await storeOver(server, clock).acquire(key);
  const taken = await storeOver(server).acquire(key, { signal });
  return { key, clock, held, taken };
}

test('the tokens of later grants are larger, across stores', async () => {
  // Arrange
  await using fixture = await sqlServerFixture(process.env);
  const server = serverAt(fixture.location);
  const stores = [storeOver(server), storeOver(server)];
  const tokens: bigint[] = [];

  // Act
  for (let index = 0; index < 4; index++) {
    const store = stores[index % 2];
    assert.ok(store);
    await using handle = await store.acquire('report:daily');
    tokens.push(handle.token.value);
  }

  // Assert
  assert.deepEqual(tokens, [1n, 2n, 3n, 4n]);
});

test('a key is free for another store as soon as its release resolves', async () => {
  // Arrange
  await using fixture = await sqlServerFixture(process.env);
  const server = serverAt(fixture.location);
  const holder = storeOver(server);
  const other = storeOver(server);
  let busy = 0;

  // Act
  for (let round = 0; round < 20; round++) {
    const handle = await holder.acquire(`report:${round}`);
    await handle[Symbol.asyncDispose]();
    const attempt = await other.tryAcquire(`report:${round}`);
    if (attempt) await attempt[Symbol.asyncDispose]();
    else busy++;
  }

  // Assert
  assert.equal(
    busy,
    0,
    'A release must free the key on the server before it resolves',
  );
});

test('two keys that differ only after 255 characters are two locks', async () => {
  // Arrange: a name column of 255 characters would cut a longer key.
  await using fixture = await sqlServerFixture(process.env);
  const server = serverAt(fixture.location);
  const prefix = 'k'.repeat(255);
  await using _ = await storeOver(server).acquire(`${prefix}:a`);

  // Act
  const other = await storeOver(server).tryAcquire(`${prefix}:b`);

  // Assert
  assert.ok(other, 'A key must not wait for another key');
  await other[Symbol.asyncDispose]();
});

const unconnected = {
  connect: () => assert.fail('The constructor must not connect'),
  table: 'dbo.mutex_leases',
  sequence: 'dbo.mutex_tokens',
  clock: globalThis,
};

test('the store refuses a lease duration that is not larger than two heartbeat intervals', () => {
  // Arrange
  const options = { ...unconnected, heartbeatInterval: 500 };

  // Act
  const atTwo = () => new SqlServerStore({ ...options, leaseDuration: 1_000 });
  const aboveTwo = () =>
    new SqlServerStore({ ...options, leaseDuration: 1_001 });

  // Assert: a holder must stop before another store can take its key.
  assert.throws(atTwo, RangeError);
  assert.doesNotThrow(aboveTwo);
});

test('the default lease duration is 30 seconds', () => {
  // Arrange, Act
  const atTwo = () =>
    new SqlServerStore({ ...unconnected, heartbeatInterval: 15_000 });
  const belowTwo = () =>
    new SqlServerStore({ ...unconnected, heartbeatInterval: 14_999 });

  // Assert
  assert.throws(atTwo, RangeError);
  assert.doesNotThrow(belowTwo);
});

test('a holder that stops renewing loses its key to a waiter leaseDuration after its last renewal, on the clock of the server', async (t) => {
  // Arrange: the holder's heartbeat runs on a clock that never moves.
  await using fixture = await sqlServerFixture(process.env);
  const server = serverAt(fixture.location);
  const key = uniqueKey();
  const held = await storeOver(server, createClock()).acquire(key);
  const [before] = await observe(
    server,
    `SELECT CONVERT(nvarchar(27), renewed, 121) AS renewed FROM dbo.mutex_leases WHERE name = CONVERT(binary(16), @name, 2)`,
    { name: leaseName(key) },
  );
  assert.ok(typeof before?.renewed === 'string');

  // Act
  await using _taken = await storeOver(server).acquire(key, {
    signal: t.signal,
  });

  // Assert: the server counts the wait from the last renewal of the holder.
  const [after] = await observe(
    server,
    `SELECT DATEDIFF(millisecond, CAST(@before AS datetime2), renewed) AS waited FROM dbo.mutex_leases WHERE name = CONVERT(binary(16), @name, 2)`,
    { name: leaseName(key), before: before.renewed },
  );
  assert.ok(
    Number(after?.waited) >= leaseDuration,
    `The waiter got the key ${String(after?.waited)} ms after the last renewal, before the lease of ${leaseDuration} ms ended`,
  );
  await held[Symbol.asyncDispose]();
});

test('a holder whose key another store took loses its lease at its next renewal', async (t) => {
  // Arrange
  await using fixture = await sqlServerFixture(process.env);
  const { clock, held, taken } = await takenOver(
    serverAt(fixture.location),
    t.signal,
  );
  await using _taken = taken;

  // Act: the heartbeat of the holder renews.
  await clock.tickAsync(heartbeatInterval);

  // Assert
  await waitFor(() => assert.ok(held.signal.aborted), { signal: t.signal });
  const reason: unknown = held.signal.reason;
  assert.ok(reason instanceof LeaseLostError);
  assert.match(String(reason.cause), /Another store took the key/);
  await held[Symbol.asyncDispose]();
});

test('the release of a holder whose key another store took leaves the key with the new holder', async (t) => {
  // Arrange
  await using fixture = await sqlServerFixture(process.env);
  const server = serverAt(fixture.location);
  const { key, held, taken } = await takenOver(server, t.signal);
  await using _taken = taken;

  // Act
  await held[Symbol.asyncDispose]();

  // Assert
  const third = await storeOver(server).tryAcquire(key);
  await using _third = third;
  assert.equal(
    third,
    undefined,
    'A late release must not free the key of the new holder',
  );
});

/** Sets read committed snapshot, the default of Azure SQL Database, on the database of `server`. */
async function readCommittedSnapshot(server: Server) {
  await observe(
    server,
    'ALTER DATABASE CURRENT SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE',
  );
}

const isolations = [false, true].map((snapshot) => ({
  snapshot,
  isolation: snapshot ? 'read committed snapshot' : 'locking read committed',
}));

void test.each(isolations, ({ snapshot, isolation }) =>
  test(`under ${isolation}, of stores that race for a key with no row, one gets the key and the others get no error`, async () => {
    // Arrange
    await using fixture = await sqlServerFixture(process.env);
    const server = serverAt(fixture.location);
    if (snapshot) await readCommittedSnapshot(server);
    const stores = Array.from({ length: 8 }, () => storeOver(server));
    const winners: number[] = [];

    // Act
    for (let round = 0; round < 20; round++) {
      const key = uniqueKey();
      const handles = await Promise.all(
        stores.map((store) => store.tryAcquire(key)),
      );
      winners.push(handles.filter(Boolean).length);
      for (const handle of handles) await handle?.[Symbol.asyncDispose]();
    }

    // Assert
    assert.deepEqual(
      winners,
      winners.map(() => 1),
      'Exactly one store must add the row of a new key',
    );
  }),
);

void test.each(isolations, ({ snapshot, isolation }) =>
  test(`under ${isolation}, of stores that race for a free key, one gets the key`, async () => {
    // Arrange: each key has a row that a holder released.
    await using fixture = await sqlServerFixture(process.env);
    const server = serverAt(fixture.location);
    if (snapshot) await readCommittedSnapshot(server);
    const stores = Array.from({ length: 8 }, () => storeOver(server));
    const winners: number[] = [];

    // Act
    for (let round = 0; round < 20; round++) {
      const key = uniqueKey();
      const first = await storeOver(server).acquire(key);
      await first[Symbol.asyncDispose]();
      const handles = await Promise.all(
        stores.map((store) => store.tryAcquire(key)),
      );
      winners.push(handles.filter(Boolean).length);
      for (const handle of handles) await handle?.[Symbol.asyncDispose]();
    }

    // Assert
    assert.deepEqual(
      winners,
      winners.map(() => 1),
      'Exactly one store must take a free key',
    );
  }),
);

test('a holder whose first session comes later than two heartbeat intervals keeps its lease, as the server starts the lease when the grant runs', async (t) => {
  // Arrange: one warm session that close() gives back, as a pool's, and only
  // the first connect waits three intervals, as a cold pool over a slow link
  // (#5973).
  await using fixture = await sqlServerFixture(process.env);
  const session = await sqlServerSession(serverAt(fixture.location));
  try {
    const pooled: SqlServerSession = {
      query: (text, parameters) => session.query(text, parameters),
      on: () => undefined,
      close: () => {},
    };
    const interval = 500;
    let connects = 0;
    const store = sqlServerStoreOn(
      async () => {
        if (connects++ === 0) await delay(3 * interval);
        return pooled;
      },
      {
        heartbeatInterval: interval,
        leaseDuration: 4 * interval,
        clock: globalThis,
      },
    );

    // Act: the holder renews three times.
    await using held = await store.acquire(uniqueKey(), { signal: t.signal });
    await delay(3 * interval);

    // Assert
    assert.equal(held.signal.aborted, false, String(held.signal.reason));
  } finally {
    session.close();
  }
});
