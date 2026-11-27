import assert from 'node:assert/strict';
import { test } from 'node:test';

import { open } from '@zukhruf/sqlite-open';

import { ConsumerGroup, CorruptCheckpointError } from '../index.ts';
import { SqliteCheckpointStore } from '../sqlite.ts';
import { position } from '../testing/formats.ts';

const inbox = { stream: 'messages', partition: 'inbox' };

test('a new store over the same database keeps the checkpoints', async () => {
  using database = open(':memory:');
  const first = await new ConsumerGroup(
    'copy',
    new SqliteCheckpointStore({ database }),
  ).claim(inbox, position);
  await first.commit(4);

  const reader = await new ConsumerGroup(
    'copy',
    new SqliteCheckpointStore({ database }),
  ).claim(inbox, position);

  assert.deepEqual(reader.checkpoint, { position: 4, checkpointId: 1 });
});

test('a write that gives a promise is refused, and the commit writes nothing', async () => {
  using database = open(':memory:');
  database.exec('CREATE TABLE output (row TEXT NOT NULL)');
  const group = new ConsumerGroup(
    'copy',
    new SqliteCheckpointStore({ database }),
  );
  const context = await group.claim(inbox, position);

  await assert.rejects(
    context.commit(1, {
      // @ts-expect-error -- the type refuses an async write; this proves the runtime check for JavaScript callers
      write: async (transaction) => {
        transaction.prepare("INSERT INTO output (row) VALUES ('late')").run();
      },
    }),
    TypeError,
  );

  assert.deepEqual(database.prepare('SELECT row FROM output').all(), []);
  assert.deepEqual(await Array.fromAsync(group.list()), []);
});

test('a stored position that is not JSON makes the claim reject with CorruptCheckpointError', async () => {
  using database = open(':memory:');
  const group = new ConsumerGroup(
    'copy',
    new SqliteCheckpointStore({ database }),
  );
  await (await group.claim(inbox, position)).commit(1);
  // No operation of the package writes a broken row: a fault of the disk or a
  // hand edit does. The test writes it as such a fault would.
  database
    .prepare('UPDATE zukhruf_checkpoints SET position = ? WHERE partition = ?')
    .run('{not json', 'inbox');

  await assert.rejects(group.claim(inbox, position), (error) => {
    assert.ok(error instanceof CorruptCheckpointError);
    assert.deepEqual(error.key, { consumerGroup: 'copy', ...inbox });
    return true;
  });
});
