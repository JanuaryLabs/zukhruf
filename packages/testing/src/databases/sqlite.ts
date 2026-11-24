import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';

export interface SqliteDatabase extends AsyncDisposable {
  path: string;
  connection: DatabaseSync;
  /** Close the connection before removing its temporary directory. */
  cleanup: () => Promise<void>;
}

/** Each acquisition owns an independent, temporary SQLite database. */
export class Sqlite {
  /** Holds a write lock in another process, which releases even while the caller blocks. */
  async writeLock(path: string, durationMs: number): Promise<AsyncDisposable> {
    const holder = promisify(execFile)(process.execPath, [
      '--input-type=module',
      '--eval',
      `
        import { DatabaseSync } from 'node:sqlite';
        import { setTimeout } from 'node:timers/promises';

        process.stdin.once('end', () => process.exit(0));
        process.stdin.resume();
        using database = new DatabaseSync(process.argv[1]);
        database.exec('BEGIN IMMEDIATE');
        process.stdout.write('locked');
        await setTimeout(Number(process.argv[2]));
        database.exec('ROLLBACK');
        process.exit(0);
      `,
      path,
      String(durationMs),
    ]);
    const exited = holder.then(() => {
      throw new Error('SQLite lock holder exited before acquiring the lock.');
    });
    try {
      await Promise.race([once(holder.child.stdout!, 'data'), exited]);
    } catch (error) {
      holder.child.kill();
      await Promise.allSettled([holder]);
      throw error;
    }

    const resources = new AsyncDisposableStack();
    resources.defer(async () => {
      const killed = holder.child.kill();
      try {
        await holder;
      } catch (error) {
        if (
          !killed ||
          !Error.isError(error) ||
          !('signal' in error) ||
          error.signal !== 'SIGTERM'
        )
          throw error;
      }
    });
    return resources;
  }

  async database(): Promise<SqliteDatabase> {
    await using resources = new AsyncDisposableStack();
    const directory = resources.use(
      await new TemporaryFiles().directory('zukhruf-testing-sqlite-'),
    );
    const path = join(directory.path, 'test.sqlite');
    const connection = resources.use(new DatabaseSync(path));
    const owned = resources.move();
    const cleanup = () => owned.disposeAsync();

    return { path, connection, cleanup, [Symbol.asyncDispose]: cleanup };
  }
}
