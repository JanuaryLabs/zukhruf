import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { TemporaryFiles } from '@zukhruf/fs';
import { Command, ProcessEndedError } from '@zukhruf/process';

export interface SqliteDatabase extends AsyncDisposable {
  path: string;
  connection: DatabaseSync;
  /** Close the connection before removing its temporary directory. */
  cleanup: () => Promise<void>;
}

/** Each acquisition owns an independent, temporary SQLite database. */
export class Sqlite {
  /**
   * Holds a write lock in another process, which releases even while the
   * caller blocks. The holder ends with this process (ADR 0004 of
   * @zukhruf/process).
   */
  async writeLock(path: string, durationMs: number): Promise<AsyncDisposable> {
    const holder = await new Command(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
        import { DatabaseSync } from 'node:sqlite';
        import { setTimeout } from 'node:timers/promises';

        using database = new DatabaseSync(process.argv[1]);
        database.exec('BEGIN IMMEDIATE');
        process.stdout.write('locked\\n');
        await setTimeout(Number(process.argv[2]));
        database.exec('ROLLBACK');
        process.exit(0);
      `,
        path,
        String(durationMs),
      ],
      // The holder needs no variable: node is an absolute path, and the
      // source imports only node:sqlite (ADR 0003 of @zukhruf/process).
      { name: 'SQLite lock holder', env: {}, clock: globalThis },
    ).start({ stdin: 'ignore', ready: { line: 'locked' } });

    const resources = new AsyncDisposableStack();
    resources.defer(async () => {
      await holder[Symbol.asyncDispose]();
      const end = await holder.ended;
      if (end.signal !== 'SIGTERM' && end.exitCode !== 0)
        throw new ProcessEndedError(
          holder.name,
          end,
          holder.stderrTail(),
          'the release of its lock',
        );
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
