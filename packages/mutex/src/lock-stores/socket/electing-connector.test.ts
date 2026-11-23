import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { Socket, createServer } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import { untilAborted } from '@zukhruf/async';
import type { CampaignOptions, Term } from '@zukhruf/election';
import { FileLock, TemporaryFiles } from '@zukhruf/fs';
import { PipeAddress } from '@zukhruf/pipes';
import { waitFor } from '@zukhruf/testing/async';

import { isRecord } from '../../shared/is-record.ts';
import { linesOf } from '../../testing/lines-of.ts';
import { standInServer } from '../../testing/stand-in-server.ts';
import { ElectingConnector } from './electing-connector.ts';
import { socketElection } from './socket-election.ts';

describe('Electing connector', () => {
  test('a process that lost its try waits on the leader, not on a timer, and tries again once the leader leaves', async (t) => {
    // Arrange: this process holds the term and serves no lock server. The
    // clock of the connector never moves, so only the leader's leave can wake it.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const election = socketElection(directory.path, globalThis);
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
      session: randomUUID(),
      address: new PipeAddress(join(directory.path, 'lock.sock')),
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
      connected: () => {},
    });

    try {
      const connecting = connector.connect(abort.signal);
      connecting.catch(() => {});
      // Nothing listens on lock.sock, so a connection is to the leader's pipe.
      await waitFor(
        () => assert.ok(connects >= 1, 'The process must watch the leader'),
        { signal: t.signal },
      );

      // Act: the leader leaves.
      await held.resign();

      // Assert
      await assert.rejects(untilAborted(connecting, t.signal), {
        name: 'AbortError',
      });
      assert.equal(
        served.length,
        1,
        'The process must win the term once the leader left',
      );
      assert.equal(
        campaigns,
        2,
        'The process must try once at the start and once after the leader left, and never while the leader lived',
      );
    } finally {
      unsubscribe('net.client.socket', onSocket);
      for (const term of served) await term.resign();
      await held.resign();
    }
  });

  test('a follower keeps its connection when the leader leaves after the welcome, and leaves the close to the kernel', async (t) => {
    // Arrange: this process holds the term, and a server on lock.sock
    // welcomes each hello and keeps each connection open.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const election = socketElection(directory.path, globalThis);
    const held = await election.campaign();
    assert.ok(held, 'The test must hold the term');
    await using _welcoming = await standInServer(
      join(directory.path, 'lock.sock'),
      (peer) => {
        linesOf(peer).once('line', () => peer.write('{"op":"welcome"}\n'));
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
      session: randomUUID(),
      address: new PipeAddress(join(directory.path, 'lock.sock')),
      election,
      serve: async () => assert.fail('A follower must not serve'),
      connected: () => {},
    });

    try {
      const connection = await connector.connect(new AbortController().signal);
      try {
        // The first connection is to lock.sock, and the second to the leader's pipe.
        await waitFor(
          () =>
            assert.equal(
              sockets[1]?.readyState,
              'open',
              'The follower must watch the leader',
            ),
          { signal: t.signal },
        );
        const [toServer, toLeader] = sockets;
        assert.ok(toServer && toLeader);
        const observerClosed = once(toLeader, 'close');

        // Act: the leader leaves, and its server keeps the connection open.
        await held.resign();
        await observerClosed;
        // The observer reports the leave in the microtasks after its close.
        await new Promise((resolve) => setImmediate(resolve));

        // Assert
        assert.equal(
          toServer.destroyed,
          false,
          'After the welcome, only the close of the leader may end the connection of a follower',
        );
      } finally {
        await connection.close();
      }
    } finally {
      unsubscribe('net.client.socket', onSocket);
      await held.resign();
    }
  });

  test('a process whose hello gets no answer gives up the connection when the leader leaves, and leads', async (t) => {
    // Arrange: this process holds the term, and a server on lock.sock reads
    // each hello and never answers it.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const election = socketElection(directory.path, globalThis);
    const held = await election.campaign();
    assert.ok(held, 'The test must hold the term');
    await using _silent = await standInServer(
      join(directory.path, 'lock.sock'),
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
      session: randomUUID(),
      address: new PipeAddress(join(directory.path, 'lock.sock')),
      election,
      serve: async (term) => {
        served.push(term);
        abort.abort();
      },
      connected: () => {},
    });

    try {
      const connecting = connector.connect(abort.signal);
      connecting.catch(() => {});
      // One connection to lock.sock, and one to the leader's pipe.
      await waitFor(
        () =>
          assert.ok(
            connects >= 2,
            'The process must greet the server and watch the leader',
          ),
        { signal: t.signal },
      );

      // Act: the leader leaves, and its server still keeps the hello unanswered.
      await held.resign();

      // Assert
      await assert.rejects(untilAborted(connecting, t.signal), {
        name: 'AbortError',
      });
      assert.equal(
        served.length,
        1,
        'The process must give up the unanswered hello and win the term',
      );
    } finally {
      unsubscribe('net.client.socket', onSocket);
      for (const term of served) await term.resign();
      await held.resign();
    }
  });

  test('a process whose leader serves no pipe tries again only at the end of a step of the back-off', async (t) => {
    // Arrange: this process holds the claim as a leader of a published version
    // does, with no leader record and no pipe. The clock of the connector moves
    // only when the test moves it.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    using claim = FileLock.open(join(directory.path, 'leader.lock'));
    assert.ok(claim.tryLock(), 'The test must hold the claim');
    const clock = createClock();
    const election = socketElection(directory.path, globalThis);
    const abort = new AbortController();
    const served: Term[] = [];
    const triedAt: number[] = [];
    const connector = new ElectingConnector({
      clock,
      session: randomUUID(),
      address: new PipeAddress(join(directory.path, 'lock.sock')),
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
      connected: () => {},
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
      await assert.rejects(untilAborted(connecting, t.signal), {
        name: 'AbortError',
      });
      assert.equal(
        served.length,
        1,
        'The process must win the term at its next try',
      );
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
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const election = socketElection(directory.path, globalThis);
    const abort = new AbortController();
    const served: Term[] = [];
    const connector = new ElectingConnector({
      clock: globalThis,
      session: randomUUID(),
      address: new PipeAddress(join(directory.path, 'lock.sock')),
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
      connected: () => {},
    });

    // Act
    const connecting = connector.connect(abort.signal);

    // Assert
    await assert.rejects(connecting, { name: 'AbortError' });
    assert.deepEqual(served, [], 'An aborted connect must not start serving');
    await using next = await socketElection(
      directory.path,
      globalThis,
    ).campaign();
    assert.ok(next, 'An aborted connect must resign the term it won');
  });

  test('a connect aborted before it starts never campaigns', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const election = socketElection(directory.path, globalThis);
    let campaigns = 0;
    const connector = new ElectingConnector({
      clock: globalThis,
      session: randomUUID(),
      address: new PipeAddress(join(directory.path, 'lock.sock')),
      election: {
        campaign: async () => {
          campaigns++;
          return undefined;
        },
        observe: () => election.observe(),
      },
      serve: async () => {},
      connected: () => {},
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
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const election = socketElection(directory.path, globalThis);
    const abort = new AbortController();
    const reason = new Error('The store closed');
    const connector = new ElectingConnector({
      clock: createClock(),
      session: randomUUID(),
      address: new PipeAddress(join(directory.path, 'lock.sock')),
      election: {
        campaign: async () => {
          setImmediate(() => abort.abort(reason));
          return undefined;
        },
        observe: () => election.observe(),
      },
      serve: async () => {},
      connected: () => {},
    });

    // Act
    const error = await connector.connect(abort.signal).then(
      () => assert.fail('An aborted connect must reject'),
      (error: unknown) => error,
    );

    // Assert
    assert.equal(error, reason);
  });

  // A step of the back-off grows to 1000 ms, longer than the successor's grace
  // window, 500 ms by default, in which the holder must reassert its keys.
  test('a process hung up on by its stopping leader follows the successor that already leads before it waits for a step of the back-off', async (t) => {
    // Arrange: the successor holds the term. One server plays the stopping
    // leader, which hangs up on the first hello, and the successor, which
    // welcomes the next. The clock of the connector never moves, so a step of
    // the back-off never ends.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const election = socketElection(directory.path, globalThis);
    const held = await election.campaign();
    assert.ok(held, 'The test must hold the term');
    let hellos = 0;
    await using _failingOver = await standInServer(
      join(directory.path, 'lock.sock'),
      (peer) => {
        linesOf(peer).once('line', () => {
          if (++hellos === 1) peer.destroy();
          else peer.write('{"op":"welcome"}\n');
        });
      },
    );
    const clock = createClock();
    const abort = new AbortController();
    const connector = new ElectingConnector({
      clock,
      session: randomUUID(),
      address: new PipeAddress(join(directory.path, 'lock.sock')),
      election,
      serve: async () => assert.fail('A follower must not serve'),
      connected: () => {},
    });
    const stepped = new AbortController();

    try {
      // Act
      const connecting = connector.connect(abort.signal);
      connecting.catch(() => {});
      const reached = await Promise.race([
        connecting.then(async (connection) => {
          await connection?.close();
          return 'the successor';
        }),
        waitFor(() => assert.equal(clock.countTimers(), 1), {
          signal: AbortSignal.any([t.signal, stepped.signal]),
        }).then(() => 'a step of the back-off'),
      ]);

      // Assert
      assert.equal(
        reached,
        'the successor',
        'After the hang-up, the process must follow the successor before it waits for a step of the back-off',
      );
      assert.equal(hellos, 2, 'The process must greet two times');
    } finally {
      stepped.abort();
      abort.abort();
      await held.resign();
    }
  });

  // Its clock never moves, so only the abort can end the wait.
  test('a connect aborted while it outlasts a leader that hangs up rejects with the reason of the signal', async (t) => {
    // Arrange: a leader hangs up on each hello, and no campaign wins.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\mutex-test-${randomUUID()}`
        : join(directory.path, 'lock.sock');
    const peers = new Set<Socket>();
    const leader = createServer((peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      linesOf(peer).once('line', () => peer.destroy());
    });
    leader.listen(socketPath);
    await once(leader, 'listening');
    const abort = new AbortController();
    const reason = new Error('The store closed');
    let reached = 0;
    const onSocket = (message: unknown) => {
      if (isRecord(message) && message.socket instanceof Socket) reached++;
    };
    subscribe('net.client.socket', onSocket);
    const election = socketElection(directory.path, globalThis);
    const clock = createClock();
    const connector = new ElectingConnector({
      clock,
      session: randomUUID(),
      address: new PipeAddress(socketPath),
      election: {
        campaign: async () => undefined,
        observe: () => election.observe(),
      },
      serve: async () => {},
      connected: () => {},
    });

    try {
      // Act: the first hang-up sends the connect to outlast the leader. After
      // the second hang-up, it waits for its next try: the abort lands in that wait.
      const connecting = connector.connect(abort.signal).then(
        () => assert.fail('An aborted connect must reject'),
        (error: unknown) => error,
      );
      await waitFor(() => assert.equal(clock.countTimers(), 1), {
        signal: t.signal,
      });
      abort.abort(reason);
      const error = await connecting;

      // Assert
      assert.equal(error, reason);
      assert.equal(reached, 2, 'The connect must reach the leader two times');
    } finally {
      unsubscribe('net.client.socket', onSocket);
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => leader.close(() => resolve()));
    }
  });
});
