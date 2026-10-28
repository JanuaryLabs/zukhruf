import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { EpochExhaustedError, type TokenSource } from '@zukhruf/fencing';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import type { Connection, ConnectionEvents } from '../connection/connection.ts';
import { KeyLocks } from '../key-lock/key-locks.ts';
import type { FlightResponse } from '../protocol/flight-protocol.ts';
import { FlightCoordinator } from './flight-coordinator.ts';

describe('A run whose epoch has no tokens left', () => {
  // Kept as a double: no test can mint 2^32 tokens, so the token source throws what EpochTokenSource throws at its end.
  test('the coordinator reports the exhausted epoch once, answers nothing, and keeps the connection', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('flights-');
    const exhausted: TokenSource = {
      async next() {
        throw new EpochExhaustedError(7n);
      },
    };
    let reports = 0;
    const coordinator = new FlightCoordinator({
      tokens: exhausted,
      locks: new KeyLocks(directory.path, 10),
      onTokensExhausted: () => reports++,
    });
    const sent: FlightResponse[] = [];
    let closes = 0;
    const connection: Connection<FlightResponse> = Object.assign(
      new EventEmitter<ConnectionEvents>(),
      {
        async send(message: FlightResponse) {
          sent.push(message);
        },
        ref() {},
        unref() {},
        close() {
          closes++;
        },
      },
    );
    coordinator.serve(connection);

    // Act
    connection.emit('message', { op: 'run', id: 'a', key: 'product:42' });
    await delay(50);

    // Assert: the leader steps down instead, so the run goes again to the next term's coordinator, as on a lost connection.
    assert.equal(reports, 1, 'The coordinator must report the exhausted epoch');
    assert.deepEqual(sent, [], 'The coordinator must not answer the run');
    assert.equal(
      closes,
      0,
      'The step-down closes the connection, not the session: a close here sends the peer back to the same leader',
    );
  });
});
