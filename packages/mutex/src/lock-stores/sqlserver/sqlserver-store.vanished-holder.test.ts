import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';
import { test } from 'node:test';

import { waitFor } from '@zukhruf/testing/async';

import { uniqueKey } from '../../testing/contract/keys.ts';
import { serverAt } from '../../testing/subjects/server.ts';
import {
  sqlServerFixture,
  sqlServerSession,
  sqlServerStoreOn,
} from '../../testing/subjects/sqlserver.ts';
import type { Endpoint } from '../../testing/tcp-proxy.ts';
import { leaseName } from './sqlserver-store.ts';

/**
 * datahub #5617: after a slot swap, Azure stopped the old container of the
 * holder in less than a second. Its session stayed on Azure SQL, behind the
 * gateway, and kept the key for 51 minutes. The server releases a session lock
 * only when it learns that the session ended, and a holder that vanished tells
 * it nothing.
 *
 * The hop below keeps the holder's connections to the server open for the
 * whole test, so the server never ends a session of the holder, and its TCP
 * keep-alive never fires. Thus only a lease that ends unless its holder renews
 * it can give the key to the waiter: about `leaseDuration` (1 s) after the last
 * renewal, on the server's clock, plus one heartbeat interval of the waiter
 * (ADR 0035). The test waits for the grant until its own limit and asserts no
 * upper bound on real time, because load breaks a speed claim
 * (zukhruf/no-wall-clock-bound).
 */

const heartbeatInterval = 200;
const leaseDuration = 1_000;

/**
 * A TCP hop in front of `target`, as the gateway of Azure SQL is with the
 * Proxy connection policy: the server talks only to the hop. `vanish()` stops
 * it forwarding in both directions. After that, it also forwards no close and
 * no reset, and it keeps its connections to the server open, as a gateway does
 * for a client machine that is gone. `proxyTo` of `src/testing/tcp-proxy.ts`
 * stops the bytes but still forwards a close, so the end of the holder's
 * session would reach the server.
 */
async function vanishingHop(target: Endpoint) {
  const vanished = new AbortController();
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(target.port, target.host);
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      sockets.add(from);
      from.on('error', () => {});
      from.on('close', () => {
        if (!vanished.signal.aborted) to.destroy();
      });
      from.on('data', (chunk) => {
        if (!vanished.signal.aborted) to.write(chunk);
      });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    host: '127.0.0.1',
    port: address.port,
    vanish: () => vanished.abort(),
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

test('a waiter gets the key of a holder that vanished with no close, though the server never sees the session end', async (t) => {
  // Arrange: the holder reaches the server through the hop, and the waiter
  // reaches it directly.
  await using fixture = await sqlServerFixture(process.env);
  const server = serverAt(fixture.location);
  await using hop = await vanishingHop(server);
  const storeOver = (endpoint: Endpoint) =>
    sqlServerStoreOn(() => sqlServerSession({ ...server, ...endpoint }), {
      heartbeatInterval,
      leaseDuration,
      clock: globalThis,
    });
  const key = uniqueKey();
  const held = await storeOver({ host: hop.host, port: hop.port }).acquire(key);
  /** The holder of the key's row and the age of its last renewal on the server's clock, read from another session. */
  const holderOnTheServer = async () => {
    const session = await sqlServerSession(server);
    try {
      const [row] = await session.query(
        `SELECT CAST(holder AS nvarchar(36)) AS holder, DATEDIFF(millisecond, renewed, SYSUTCDATETIME()) AS age
         FROM dbo.mutex_leases WHERE name = CONVERT(binary(16), @name, 2)`,
        { name: leaseName(key) },
      );
      return row === undefined
        ? 'no row'
        : `holder ${String(row.holder)}, renewed ${String(row.age)} ms ago`;
    } finally {
      session.close();
    }
  };
  const vanishedHolder = await holderOnTheServer();
  const cancel = new AbortController();
  const ended = new Error('The test ends');
  let granted = false;
  await using cleanup = new AsyncDisposableStack();

  // Act: the holder's machine vanishes, and another process asks for the key.
  hop.vanish();
  const waiting = storeOver(server)
    .acquire(key, { signal: AbortSignal.any([t.signal, cancel.signal]) })
    .then(
      async (lease) => {
        granted = true;
        await lease[Symbol.asyncDispose]();
        return ended;
      },
      (error: unknown) => error,
    );
  cleanup.defer(async () => {
    cancel.abort(ended);
    const outcome = await waiting;
    await held[Symbol.asyncDispose]();
    // A wait that the test ended, or the test's own limit, is no failure of the waiter.
    if (outcome !== ended && outcome !== t.signal.reason) throw outcome;
  });

  // Assert
  await waitFor(
    () =>
      assert.ok(
        held.signal.aborted,
        'The holder must learn from its heartbeat that it may have lost the key (ADR 0013)',
      ),
    { signal: t.signal },
  );
  // The runner reports only its own time limit, so the report gets the last
  // unmet check as a diagnostic.
  let unmet = '';
  t.signal.addEventListener('abort', () => t.diagnostic(unmet), {
    once: true,
  });
  await waitFor(
    async () => {
      unmet = `A waiter must get the key about leaseDuration after its holder's silent end, but the row reads ${await holderOnTheServer()}; at the vanish it read ${vanishedHolder}, and that holder's own lease aborted`;
      assert.ok(granted, unmet);
    },
    { signal: t.signal, interval: heartbeatInterval },
  );
});
