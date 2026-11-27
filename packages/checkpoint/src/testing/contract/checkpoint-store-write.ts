import assert from 'node:assert/strict';

import { suite, test } from '@zukhruf/parameterized-test';

import {
  CheckpointFencedError,
  type CheckpointStore,
  ConsumerGroup,
  type Format,
} from '../../index.ts';
import { position, text } from '../formats.ts';

/**
 * A store whose commit can run an output write in its transaction (ADR 0007).
 * `write` adds a row to an output table of the store's database, and
 * `failingWrite` adds the row and then throws. `ran` gives the rows whose
 * write was called, kept outside the database, so a rollback cannot hide a call.
 */
export type WriteSubject<W> = {
  readonly name: string;
  open(): Promise<
    AsyncDisposable & {
      readonly store: CheckpointStore<W>;
      write(row: string): W;
      failingWrite(row: string, error: Error): W;
      outputs(): Promise<readonly string[]>;
      ran(): readonly string[];
    }
  >;
};

const inbox = { stream: 'messages', partition: 'inbox' };

/** The rules of ADRs 0007 and 0008 for the write of a commit. */
export function checkpointStoreWriteContract<W>(
  subject: WriteSubject<W>,
): void {
  suite(`${subject.name} write`, () => {
    test('a write commits its output with the checkpoint and the map states', async () => {
      await using opened = await subject.open();
      const group = new ConsumerGroup('copy', opened.store);
      const context = await group.claim(inbox, position);
      context.state('seen', text).set('a', 'x');

      await context.commit(1, { write: opened.write('row 1') });

      assert.deepEqual(await opened.outputs(), ['row 1']);
      const reader = await group.claim(inbox, position);
      assert.deepEqual(reader.checkpoint, { position: 1, checkpointId: 1 });
      assert.equal(await reader.state('seen', text).get('a'), 'x');
    });

    test('a write that throws after its output rolls back the output, the checkpoint and the map states, and a retry commits them', async () => {
      await using opened = await subject.open();
      const group = new ConsumerGroup('copy', opened.store);
      const context = await group.claim(inbox, position);
      context.state('seen', text).set('a', 'x');
      const error = new Error('the destination refused the row');

      await assert.rejects(
        context.commit(1, { write: opened.failingWrite('row 1', error) }),
        (thrown) => {
          assert.equal(thrown, error);
          return true;
        },
      );

      assert.deepEqual(await opened.outputs(), []);
      assert.deepEqual(await Array.fromAsync(group.list()), []);
      assert.equal(
        (
          await opened.store.get({ consumerGroup: 'copy', ...inbox }, 'seen', [
            'a',
          ])
        ).size,
        0,
      );
      await context.commit(1, { write: opened.write('row 1') });
      assert.deepEqual(await opened.outputs(), ['row 1']);
      const reader = await group.claim(inbox, position);
      assert.equal(await reader.state('seen', text).get('a'), 'x');
    });

    test('a commit of a fenced claim runs no write', async () => {
      await using opened = await subject.open();
      const group = new ConsumerGroup('copy', opened.store);
      const older = await group.claim(inbox, position);
      await group.claim(inbox, position);

      await assert.rejects(
        older.commit(1, { write: opened.write('zombie row') }),
        CheckpointFencedError,
      );

      assert.deepEqual(opened.ran(), []);
      assert.deepEqual(await opened.outputs(), []);
    });
  });
}
