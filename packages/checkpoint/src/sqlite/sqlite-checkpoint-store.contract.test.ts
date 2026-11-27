import { open } from '@zukhruf/sqlite-open';

import { SqliteCheckpointStore } from '../sqlite.ts';
import { checkpointStoreWriteContract } from '../testing/contract/checkpoint-store-write.ts';
import { checkpointStoreContract } from '../testing/contract/checkpoint-store.ts';

checkpointStoreContract({
  name: 'SqliteCheckpointStore',
  open: async () => {
    const database = open(':memory:');
    return {
      store: new SqliteCheckpointStore({ database }),
      [Symbol.asyncDispose]: async () => database.close(),
    };
  },
});

checkpointStoreWriteContract({
  name: 'SqliteCheckpointStore',
  open: async () => {
    const database = open(':memory:');
    database.exec('CREATE TABLE output (row TEXT NOT NULL)');
    const ran: string[] = [];
    const insert = (row: string) => {
      ran.push(row);
      database.prepare('INSERT INTO output (row) VALUES (?)').run(row);
    };
    return {
      store: new SqliteCheckpointStore({ database }),
      write: (row) => () => {
        insert(row);
      },
      failingWrite: (row, error) => () => {
        insert(row);
        throw error;
      },
      outputs: async () =>
        database
          .prepare('SELECT row FROM output ORDER BY rowid')
          .all()
          .map(({ row }) => String(row)),
      ran: () => ran,
      [Symbol.asyncDispose]: async () => database.close(),
    };
  },
});
