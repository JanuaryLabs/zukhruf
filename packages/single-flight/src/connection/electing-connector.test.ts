import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { Socket, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import type { CampaignOptions, Term } from '@zukhruf/election';
import { FileLock, TemporaryFiles } from '@zukhruf/fs';
import { PipeAddress } from '@zukhruf/pipes';
import { waitFor } from '@zukhruf/testing/async';

import { isRecord } from '../shared/is-record.ts';
import { standInServer } from '../testing/stand-in-server.ts';
import { ElectingConnector } from './electing-connector.ts';
import { flightElection } from './flight-election.ts';

describe('Electing connector', () => {
  test('a process that lost its try waits on the coordinator, not on a timer, and tries again once the coordinator leaves', async (t) => {
    // Arrange: this process holds the term and serves no flight server. The
    // clock of the connector never moves, so only the coordinator's leave can wake it.
    await using directory = await new TemporaryFiles().directory('flights-');
    const election = flightElection(directory.path, globalThis);
    const held = await election.campaign();
    assert.ok(held, 'The test must hold the term');
    const abort = new AbortController();
    const served: Term[] = [];
    let campaigns = 0;
    let connects = 0;
    const onSocket = (message: unknown) => {
      if (!isRecord(message) || !(message.socket instanceof Socket)) return;
      message.socket.once('connect', () => connects++);
    };
    subscribe('net.client.socket', onSocket);
    const connector = new ElectingConnector({
      clock: createClock(),
      address: new PipeAddress(join(directory.path, 'flight.sock')),
      election: {
        campaign: (options?: CampaignOptions) => {
          campaigns++;
          return election.campaign(options);
        },
        observe: () => election.observe(),
      },
      serve: async (term) => {
        served.push(term);
        abort.abort();
      },
    });

    try {
      const connecting = connector.connect(abort.signal);
      connecting.catch(() => {});
      // Nothing listens on flight.sock, so a connection is to the coordinator's pipe.
      await waitFor(
        () =>
          assert.ok(connects >= 1, 'The process must watch the coordinator'),
        { signal: t.signal },
      );

      // Act: the coordinator leaves.
      await held.resign();

      // Assert
      await waitFor(
        () =>
          assert.equal(
            served.length,
            1,
            'The process must win the term once the coordinator left',
          ),
        { signal: t.signal },
      );
      await assert.rejects(connecting, { name: 'AbortError' });
      assert.equal(
        campaigns,
        2,
        'The process must try once at the start and once after the coordinator left, and never while the coordinator lived',
      );
    } finally {
      unsubscribe('net.client.socket', onSocket);
      for (const term of served) await term.resign();
      await held.resign();
    }
  });

  test('a follower keeps its connection when the coordinator leaves after the welcome, and leaves the close to the kernel', async (t) => {
    // Arrange: this process holds the term, and a server on flight.sock
    // welcomes each hello and keeps each connection open.
    await using directory = await new TemporaryFiles().directory('flights-');
    const election = flightElection(directory.path, globalThis);
    const held = await election.campaign();
    assert.ok(held, 'The test must hold the term');
    await using _welcoming = await standInServer(
      join(directory.path, 'flight.sock'),
      (peer) => {
        createInterface({ input: peer })
          .on('error', () => {})
          .once('line', () => peer.write('{"op":"welcome"}\n'));
      },
    );
    const sockets: Socket[] = [];
    const onSocket = (message: unknown) => {
      if (isRecord(message) && message.socket instanceof Socket)
        sockets.push(message.socket);
    };
    subscribe('net.client.socket', onSocket);
    const connector = new ElectingConnector({
      clock: globalThis,
      address: new PipeAddress(join(directory.path, 'flight.sock')),
      election,
      serve: async () => assert.fail('A follower must not serve'),
    });

    try {
      const connection = await connector.connect(new AbortController().signal);
      try {
        // The first connection is to flight.sock, and the second to the coordinator's pipe.
        await waitFor(
          () =>
            assert.equal(
              sockets[1]?.readyState,
              'open',
              'The follower must watch the coordinator',
            ),
          { signal: t.signal },
        );
        const [toServer, toCoordinator] = sockets;
        assert.ok(toServer && toCoordinator);
        const observerClosed = once(toCoordinator, 'close');

        // Act: the coordinator leaves, and its server keeps the connection open.
        await held.resign();
        await observerClosed;
        // The observer reports the leave in the microtasks after its close.
        await nextTurn();

        // Assert
        assert.equal(
          toServer.destroyed,
          false,
          'After the welcome, only the close of the coordinator may end the connection of a follower',
        );
      } finally {
        connection.close();
      }
    } finally {
      unsubscribe('net.client.socket', onSocket);
      await held.resign();
    }
  });

  test('a process whose hello gets no answer gives up the connection when the coordinator leaves, and coordinates', async (t) => {
    // Arrange: this process holds the term, and a server on flight.sock reads
    // each hello and never answers it.
    await using directory = await new TemporaryFiles().directory('flights-');
    const election = flightElection(directory.path, globalThis);
    const held = await election.campaign();
    assert.ok(held, 'The test must hold the term');
    await using _silent = await standInServer(
      join(directory.path, 'flight.sock'),
      (peer) => peer.resume(),
    );
    const abort = new AbortController();
    const served: Term[] = [];
    let connects = 0;
    const onSocket = (message: unknown) => {
      if (!isRecord(message) || !(message.socket instanceof Socket)) return;
      message.socket.once('connect', () => connects++);
    };
    subscribe('net.client.socket', onSocket);
    const connector = new ElectingConnector({
      clock: globalThis,
      address: new PipeAddress(join(directory.path, 'flight.sock')),
      election,
      serve: async (term) => {
        served.push(term);
        abort.abort();
      },
    });

    try {
      const connecting = connector.connect(abort.signal);
      connecting.catch(() => {});
      // One connection to flight.sock, and one to the coordinator's pipe.
      await waitFor(
        () =>
          assert.ok(
            connects >= 2,
            'The process must greet the server and watch the coordinator',
          ),
        { signal: t.signal },
      );

      // Act: the coordinator leaves, and its server still keeps the hello unanswered.
      await held.resign();

      // Assert
      await waitFor(
        () =>
          assert.equal(
            served.length,
            1,
            'The process must give up the unanswered hello and win the term',
          ),
        { signal: t.signal },
      );
      await assert.rejects(connecting, { name: 'AbortError' });
    } finally {
      unsubscribe('net.client.socket', onSocket);
      for (const term of served) await term.resign();
      await held.resign();
    }
  });

  test('a process whose coordinator serves no pipe tries again only at the end of a step of the back-off', async (t) => {
    // Arrange: this process holds the claim as a coordinator of a published
    // version does, with no leader record and no pipe. The clock of the
    // connector moves only when the test moves it.
    await using directory = await new TemporaryFiles().directory('flights-');
    using claim = FileLock.open(join(directory.path, 'flight.lock'));
    assert.ok(claim.tryLock(), 'The test must hold the claim');
    const clock = createClock();
    const election = flightElection(directory.path, globalThis);
    const abort = new AbortController();
    const served: Term[] = [];
    const triedAt: number[] = [];
    const connector = new ElectingConnector({
      clock,
      address: new PipeAddress(join(directory.path, 'flight.sock')),
      election: {
        campaign: (options?: CampaignOptions) => {
          triedAt.push(clock.now);
          return election.campaign(options);
        },
        observe: () => election.observe(),
      },
      serve: async (term) => {
        served.push(term);
        abort.abort();
      },
    });

    try {
      const connecting = connector.connect(abort.signal);
      connecting.catch(() => {});
      await waitFor(
        () =>
          assert.equal(
            clock.countTimers(),
            1,
            'The process must wait for a step of the back-off',
          ),
        { signal: t.signal },
      );
      assert.equal(
        triedAt.length,
        1,
        'The process must not try again before the step ends',
      );

      // Act: the holder lets the claim go, and the first step ends (25 ms ± 20 %).
      claim.unlock();
      await clock.tickAsync(30);

      // Assert
      await waitFor(
        () =>
          assert.equal(
            served.length,
            1,
            'The process must win the term at its next try',
          ),
        { signal: t.signal },
      );
      await assert.rejects(connecting, { name: 'AbortError' });
      const [first, second, ...more] = triedAt;
      assert.ok(
        first !== undefined && second !== undefined && more.length === 0,
        `The process must try two times, not ${triedAt.length}`,
      );
      assert.ok(
        second - first >= 20,
        `The next try must wait the first step, 25 ms less 20 % at the least, not ${second - first} ms`,
      );
    } finally {
      for (const term of served) await term.resign();
    }
  });

  test('a connect aborted while it campaigns resigns the term it wins and never serves', async () => {
    // Arrange: nobody serves the directory, and the abort lands while the campaign wins.
    await using directory = await new TemporaryFiles().directory('flights-');
    const election = flightElection(directory.path, globalThis);
    const abort = new AbortController();
    const served: Term[] = [];
    const connector = new ElectingConnector({
      clock: globalThis,
      address: new PipeAddress(join(directory.path, 'flight.sock')),
      election: {
        campaign: async (options?: CampaignOptions) => {
          const won = await election.campaign(options);
          abort.abort();
          return won;
        },
        observe: () => election.observe(),
      },
      serve: async (term) => {
        served.push(term);
      },
    });

    // Act
    const connecting = connector.connect(abort.signal);

    // Assert
    await assert.rejects(connecting, { name: 'AbortError' });
    assert.deepEqual(served, [], 'An aborted connect must not start serving');
    await using next = await flightElection(
      directory.path,
      globalThis,
    ).campaign();
    assert.ok(next, 'An aborted connect must resign the term it won');
  });

  test('a connect aborted before it starts never campaigns', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('flights-');
    const election = flightElection(directory.path, globalThis);
    let campaigns = 0;
    const connector = new ElectingConnector({
      clock: globalThis,
      address: new PipeAddress(join(directory.path, 'flight.sock')),
      election: {
        campaign: async () => {
          campaigns++;
          return undefined;
        },
        observe: () => election.observe(),
      },
      serve: async () => {},
    });

    // Act
    const connecting = connector.connect(AbortSignal.abort());

    // Assert
    await assert.rejects(connecting, { name: 'AbortError' });
    assert.equal(campaigns, 0, 'An aborted connect must not campaign');
  });

  // The clock of the connector never moves, so only the abort can end the wait.
  test('a connect aborted while it waits for its next try rejects with the reason of the signal', async () => {
    // Arrange: nobody serves the socket, and no campaign wins. The abort lands
    // after the lost campaign returned, so the connect waits for its next try.
    await using directory = await new TemporaryFiles().directory('flights-');
    const election = flightElection(directory.path, globalThis);
    const abort = new AbortController();
    const reason = new Error('The single flight closed');
    const connector = new ElectingConnector({
      clock: createClock(),
      address: new PipeAddress(join(directory.path, 'flight.sock')),
      election: {
        campaign: async () => {
          setImmediate(() => abort.abort(reason));
          return undefined;
        },
        observe: () => election.observe(),
      },
      serve: async () => {},
    });

    // Act
    const error = await connector.connect(abort.signal).then(
      () => assert.fail('An aborted connect must reject'),
      (error: unknown) => error,
    );

    // Assert
    assert.equal(error, reason);
  });

  // A connector that opens another number of sockets before it waits never
  // gets the abort. Its clock never moves, so only the abort can end the wait.
  test('a connect aborted while it outlasts a coordinator that hangs up rejects with the reason of the signal', async () => {
    // Arrange: a coordinator hangs up on each hello, and no campaign wins.
    await using directory = await new TemporaryFiles().directory('flights-');
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\single-flight-test-${randomUUID()}`
        : join(directory.path, 'flight.sock');
    const peers = new Set<Socket>();
    const coordinator = createServer((peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      // readline emits the socket's errors again, e.g. a reset on Linux when the client closes with unread data.
      createInterface({ input: peer })
        .on('error', () => {})
        .once('line', () => peer.destroy());
    });
    coordinator.listen(socketPath);
    await once(coordinator, 'listening');
    const abort = new AbortController();
    const reason = new Error('The single flight closed');
    // The first hang-up sends the connect to outlast the coordinator. After
    // the second hang-up, it waits for its next try: the abort lands in that
    // wait, one turn after the socket closes.
    let reached = 0;
    const onSocket = (message: unknown) => {
      if (!isRecord(message) || !(message.socket instanceof Socket)) return;
      if (++reached !== 2) return;
      message.socket.once('close', () =>
        setImmediate(() => abort.abort(reason)),
      );
    };
    subscribe('net.client.socket', onSocket);
    const election = flightElection(directory.path, globalThis);
    const connector = new ElectingConnector({
      clock: createClock(),
      address: new PipeAddress(socketPath),
      election: {
        campaign: async () => undefined,
        observe: () => election.observe(),
      },
      serve: async () => {},
    });

    try {
      // Act
      const error = await connector.connect(abort.signal).then(
        () => assert.fail('An aborted connect must reject'),
        (error: unknown) => error,
      );

      // Assert
      assert.equal(error, reason);
      assert.equal(
        reached,
        2,
        'The connect must reach the coordinator two times',
      );
    } finally {
      unsubscribe('net.client.socket', onSocket);
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => coordinator.close(() => resolve()));
    }
  });

  test('a connect outlasts a coordinator that keeps its term and hangs up on each hello, for as long as that lasts', async (t) => {
    // Arrange: for five seconds on the clock, a coordinator hangs up on each hello and no campaign wins. After them, it welcomes.
    await using directory = await new TemporaryFiles().directory('flights-');
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\single-flight-test-${randomUUID()}`
        : join(directory.path, 'flight.sock');
    const clock = createClock();
    const peers = new Set<Socket>();
    let hangUps = 0;
    const coordinator = createServer((peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      // readline emits the socket's errors again, e.g. a reset on Linux when the client closes with unread data.
      createInterface({ input: peer })
        .on('error', () => {})
        .once('line', () => {
          if (clock.now >= 5000) return peer.write('{"op":"welcome"}\n');
          hangUps++;
          peer.destroy();
        });
    });
    coordinator.listen(socketPath);
    await once(coordinator, 'listening');
    const election = flightElection(directory.path, globalThis);
    const connector = new ElectingConnector({
      clock,
      address: new PipeAddress(socketPath),
      election: {
        campaign: async () => undefined,
        observe: () => election.observe(),
      },
      serve: async () => {},
    });
    const ticking = setInterval(() => clock.tick(10), 1);

    try {
      // Act
      const connection = await connector.connect(t.signal);
      connection.close();

      // Assert
      assert.ok(hangUps > 1, `The coordinator hung up ${hangUps} times`);
    } finally {
      clearInterval(ticking);
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => coordinator.close(() => resolve()));
    }
  });
});
