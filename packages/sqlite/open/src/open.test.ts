import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  DeniedError,
  type Journal,
  MissingError,
  PersistentWriteAheadLog,
  RollbackJournal,
  UnavailableError,
  UnchangedJournal,
  WriteAheadLog,
  open,
} from './index.ts';

// chmod denies nothing on Windows, and nothing to root.
const noChmod = process.platform === 'win32' || process.getuid?.() === 0;

const journals = [
  ['WriteAheadLog', () => new WriteAheadLog()],
  ['PersistentWriteAheadLog', () => new PersistentWriteAheadLog()],
] as const;

// Runs a script in a new node process that imports this package's source, as
// a second program that opens the same database does.
function inChild(script: string): ReturnType<typeof spawnSync> {
  const index = new URL('./index.ts', import.meta.url).href;
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { open, PersistentWriteAheadLog, WriteAheadLog } from ${JSON.stringify(index)};\n${script}`,
    ],
    { encoding: 'utf8' },
  );
}

test(
  'a reader that cannot write the folder reads a persistent write-ahead log after the owner closes',
  // chmod 0555 stands in for the Codex sandbox, which lets a reader read the
  // folder but not write it.
  { skip: noChmod },
  async () => {
    await using dir = await new TemporaryFiles().directory('open-');
    const path = join(dir.path, 'notes.sqlite');
    {
      using owner = open(path, { journal: new PersistentWriteAheadLog() });
      owner.exec(`CREATE TABLE notes (title TEXT);
        INSERT INTO notes VALUES ('first')`);
    }
    await chmod(dir.path, 0o555);
    try {
      using reader = open(path, { readOnly: true });

      assert.deepEqual(
        reader
          .prepare('SELECT title FROM notes')
          .all()
          .map((row) => row.title),
        ['first'],
      );
    } finally {
      await chmod(dir.path, 0o755);
    }
  },
);

for (const [name, journal] of journals) {
  test(`${name}: a reader does not wait for an owner that writes a large transaction`, async () => {
    await using dir = await new TemporaryFiles().directory('open-');
    const path = join(dir.path, 'notes.sqlite');
    using owner = open(path, { journal: journal() });
    owner.exec(`CREATE TABLE notes (title TEXT);
      INSERT INTO notes VALUES ('first')`);
    // A transaction larger than the page cache: in a rollback journal it
    // takes the exclusive lock before the commit, and stops every reader.
    owner.exec('PRAGMA cache_size = 1; BEGIN');
    const insert = owner.prepare('INSERT INTO notes VALUES (?)');
    for (let row = 0; row < 2000; row++) insert.run('x'.repeat(200));
    try {
      using reader = open(path, { readOnly: true, timeout: 0 });

      assert.deepEqual(
        reader
          .prepare('SELECT title FROM notes')
          .all()
          .map((row) => row.title),
        ['first'],
      );
    } finally {
      owner.exec('ROLLBACK');
    }
  });

  test(`${name}: an owner killed inside a write transaction leaves a file that a reader reads at once, with only the commits`, async () => {
    await using dir = await new TemporaryFiles().directory('open-');
    const path = join(dir.path, 'notes.sqlite');
    const child = inChild(`
        const owner = open(${JSON.stringify(path)}, { journal: new ${name}() });
        owner.exec("CREATE TABLE notes (title TEXT); INSERT INTO notes VALUES ('first')");
        owner.exec('PRAGMA cache_size = 1; BEGIN');
        const insert = owner.prepare('INSERT INTO notes VALUES (?)');
        for (let row = 0; row < 2000; row++) insert.run('x'.repeat(200));
        process.kill(process.pid, 'SIGKILL');`);
    assert.equal(child.signal, 'SIGKILL', String(child.stderr));

    using reader = open(path, { readOnly: true, timeout: 0 });

    assert.deepEqual(
      reader
        .prepare('SELECT title FROM notes')
        .all()
        .map((row) => row.title),
      ['first'],
    );
  });
}

test('a reader never changes a database in a rollback journal', async () => {
  await using dir = await new TemporaryFiles().directory('open-');
  const path = join(dir.path, 'vendor.sqlite');
  // A program that is not ours keeps its store in a rollback journal.
  {
    using vendor = new DatabaseSync(path);
    vendor.exec(`CREATE TABLE notes (title TEXT);
      INSERT INTO notes VALUES ('first')`);
  }
  const before = readFileSync(path);

  {
    using reader = open(path, { readOnly: true });
    assert.equal(
      reader.prepare('PRAGMA journal_mode').get()?.journal_mode,
      'delete',
    );
    reader.prepare('SELECT title FROM notes').all();
  }

  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readdirSync(dir.path).toSorted(), ['vendor.sqlite']);
});

// The failures that the caller can fix are UnavailableError, with the path
// and the error of SQLite as the cause.
// CANTOPEN (14) for a missing or denied file; READONLY_DIRECTORY (1544) for
// a folder that denies the write of the journal.
function unavailable(path: string, errcode: 14 | 1544 = 14) {
  return (error: unknown) => {
    assert.ok(error instanceof UnavailableError, String(error));
    assert.equal(error.path, path);
    assert.ok(Error.isError(error.cause) && 'errcode' in error.cause);
    assert.equal(error.cause.errcode, errcode);
    return true;
  };
}

test('a missing file, or a missing folder, is an UnavailableError', async () => {
  await using dir = await new TemporaryFiles().directory('open-');
  const file = join(dir.path, 'missing.sqlite');
  const folder = join(dir.path, 'missing', 'notes.sqlite');

  assert.throws(() => open(file, { readOnly: true }), unavailable(file));
  assert.throws(() => open(folder), unavailable(folder));
});

test(
  'a file that the system denies is an UnavailableError, for a reader and for an owner',
  // chmod 000 stands in for a privacy denial of macOS, which gives SQLite the
  // same CANTOPEN (14).
  { skip: noChmod },
  async () => {
    await using dir = await new TemporaryFiles().directory('open-');
    const path = join(dir.path, 'notes.sqlite');
    open(path).close();
    await chmod(path, 0o000);

    assert.throws(() => open(path, { readOnly: true }), unavailable(path));
    assert.throws(() => open(path), unavailable(path));
  },
);

test(
  'an owner in a folder that it cannot write is an UnavailableError',
  { skip: noChmod },
  async () => {
    await using dir = await new TemporaryFiles().directory('open-');
    const path = join(dir.path, 'notes.sqlite');
    new DatabaseSync(path).close();
    await chmod(dir.path, 0o555);
    try {
      assert.throws(() => open(path), unavailable(path, 1544));
    } finally {
      await chmod(dir.path, 0o755);
    }
  },
);

test('a file that is not a database is the error of SQLite, not an UnavailableError', async () => {
  await using dir = await new TemporaryFiles().directory('open-');
  const path = join(dir.path, 'notes.sqlite');
  writeFileSync(
    path,
    'not a database, but a text file of more than one page. '.repeat(100),
  );

  for (const attempt of [
    () => open(path),
    () =>
      open(path, { readOnly: true })
        .prepare('SELECT 1 FROM sqlite_schema')
        .get(),
  ])
    assert.throws(attempt, (error: unknown) => {
      assert.ok(!(error instanceof UnavailableError), String(error));
      assert.ok(Error.isError(error) && 'errcode' in error);
      assert.equal(error.errcode, 26);
      return true;
    });
});

test(
  'an owner whose journal step fails leaves no file open',
  { skip: !existsSync('/dev/fd') },
  async () => {
    await using dir = await new TemporaryFiles().directory('open-');
    const path = join(dir.path, 'notes.sqlite');
    writeFileSync(
      path,
      'not a database, but a text file of more than one page. '.repeat(100),
    );
    const before = readdirSync('/dev/fd').length;

    assert.throws(
      () => open(path),
      (error: unknown) =>
        Error.isError(error) && 'errcode' in error && error.errcode === 26,
    );

    assert.equal(readdirSync('/dev/fd').length, before);
  },
);

test(
  'UnavailableError.from takes the file system codes for a missing or denied file',
  { skip: noChmod },
  async () => {
    await using dir = await new TemporaryFiles().directory('open-');
    const file = join(dir.path, 'notes.sqlite');
    writeFileSync(file, '');
    const denied = join(dir.path, 'denied.sqlite');
    writeFileSync(denied, '');
    await chmod(denied, 0o000);
    const failures = {
      ENOENT: () => statSync(join(dir.path, 'missing.sqlite')),
      ENOTDIR: () => statSync(join(file, 'child.sqlite')),
      EACCES: () => readFileSync(denied),
      // Only root can give a file to another user.
      EPERM: () => chownSync(file, 0, 0),
    };

    for (const [code, fail] of Object.entries(failures)) {
      const error = thrown(fail);
      assert.ok(
        Error.isError(error) && 'code' in error && error.code === code,
        code,
      );
      const unavailable = UnavailableError.from(file, error);
      assert.ok(unavailable instanceof UnavailableError, code);
      assert.equal(unavailable.path, file);
      assert.equal(unavailable.cause, error);
    }
    assert.equal(UnavailableError.from(file, new Error('other')), undefined);
  },
);

// The class says which of the two the caller must fix: a MissingError is a
// wrong path, a DeniedError is a grant that the process does not have.
function unavailableAs(
  kind: typeof MissingError | typeof DeniedError,
  path: string,
  errcode: 14 | 1544 = 14,
) {
  return (error: unknown) => {
    assert.ok(error instanceof kind, String(error));
    assert.equal(error.name, kind.name);
    assert.equal(error.path, path);
    assert.ok(Error.isError(error.cause) && 'errcode' in error.cause);
    assert.equal(error.cause.errcode, errcode);
    return true;
  };
}

test('a path with no file is a MissingError', async () => {
  // Arrange
  await using dir = await new TemporaryFiles().directory('open-');
  const path = join(dir.path, 'missing.sqlite');

  // Act
  const opening = () => open(path, { readOnly: true });

  // Assert
  assert.throws(opening, unavailableAs(MissingError, path));
});

test('a file in a folder that is not there, or below a file, is a MissingError, for a reader and for an owner', async () => {
  // Arrange
  await using dir = await new TemporaryFiles().directory('open-');
  const inMissingFolder = join(dir.path, 'missing', 'notes.sqlite');
  const file = join(dir.path, 'notes.sqlite');
  writeFileSync(file, '');
  const belowFile = join(file, 'child.sqlite');

  // Act
  const attempts = [inMissingFolder, belowFile].flatMap((path) => [
    [path, () => open(path, { readOnly: true })] as const,
    [path, () => open(path)] as const,
  ]);

  // Assert
  for (const [path, opening] of attempts)
    assert.throws(opening, unavailableAs(MissingError, path));
});

test(
  'a file with mode 000 is a DeniedError, for a reader and for an owner',
  { skip: noChmod },
  async () => {
    // Arrange
    await using dir = await new TemporaryFiles().directory('open-');
    const path = join(dir.path, 'notes.sqlite');
    open(path).close();
    await chmod(path, 0o000);

    // Act
    const reading = () => open(path, { readOnly: true });
    const owning = () => open(path);

    // Assert
    assert.throws(reading, unavailableAs(DeniedError, path));
    assert.throws(owning, unavailableAs(DeniedError, path));
  },
);

test(
  'a path in a folder with mode 000 is a DeniedError, with or without a file there',
  // The system does not say whether a file is in a folder that it denies.
  { skip: noChmod },
  async () => {
    // Arrange
    await using dir = await new TemporaryFiles().directory('open-');
    const folder = join(dir.path, 'denied');
    const present = join(folder, 'notes.sqlite');
    const absent = join(folder, 'missing.sqlite');
    mkdirSync(folder);
    open(present).close();
    await chmod(folder, 0o000);
    try {
      // Act
      const attempts = [present, absent].flatMap((path) => [
        [path, () => open(path, { readOnly: true })] as const,
        [path, () => open(path)] as const,
      ]);

      // Assert
      for (const [path, opening] of attempts)
        assert.throws(opening, unavailableAs(DeniedError, path));
    } finally {
      await chmod(folder, 0o755);
    }
  },
);

test(
  'an owner in a folder that it cannot write is a DeniedError',
  { skip: noChmod },
  async () => {
    // Arrange
    await using dir = await new TemporaryFiles().directory('open-');
    const path = join(dir.path, 'notes.sqlite');
    new DatabaseSync(path).close();
    await chmod(dir.path, 0o555);
    try {
      // Act
      const owning = () => open(path);

      // Assert
      assert.throws(owning, unavailableAs(DeniedError, path, 1544));
    } finally {
      await chmod(dir.path, 0o755);
    }
  },
);

test(
  'a failure that the second look cannot decide is a plain UnavailableError',
  { skip: noChmod },
  async () => {
    // Arrange: a symbolic link to itself is not missing and not denied, and
    // the file system cannot open the text of a file: URL as a path.
    await using dir = await new TemporaryFiles().directory('open-');
    const loop = join(dir.path, 'loop.sqlite');
    symlinkSync(loop, loop);
    const denied = join(dir.path, 'notes.sqlite');
    open(denied).close();
    await chmod(denied, 0o000);
    const url = pathToFileURL(denied);

    // Act
    const attempts = [
      [loop, () => open(loop, { readOnly: true })] as const,
      [String(url), () => open(url, { readOnly: true })] as const,
    ];

    // Assert
    for (const [path, opening] of attempts)
      assert.throws(opening, (error: unknown) => {
        assert.ok(unavailable(path)(error));
        assert.ok(!(error instanceof MissingError), String(error));
        assert.ok(!(error instanceof DeniedError), String(error));
        return true;
      });
  },
);

test(
  'UnavailableError.from gives a MissingError for ENOENT and ENOTDIR, and a DeniedError for EACCES and EPERM',
  { skip: noChmod },
  async () => {
    // Arrange
    await using dir = await new TemporaryFiles().directory('open-');
    const file = join(dir.path, 'notes.sqlite');
    writeFileSync(file, '');
    const denied = join(dir.path, 'denied.sqlite');
    writeFileSync(denied, '');
    await chmod(denied, 0o000);
    const failures = [
      [
        MissingError,
        'ENOENT',
        () => statSync(join(dir.path, 'missing.sqlite')),
      ],
      [MissingError, 'ENOTDIR', () => statSync(join(file, 'child.sqlite'))],
      [DeniedError, 'EACCES', () => readFileSync(denied)],
      // Only root can give a file to another user.
      [DeniedError, 'EPERM', () => chownSync(file, 0, 0)],
    ] as const;

    for (const [kind, code, fail] of failures) {
      const error = thrown(fail);
      assert.ok(
        Error.isError(error) && 'code' in error && error.code === code,
        code,
      );

      // Act
      const unavailable = UnavailableError.from(file, error);

      // Assert
      assert.ok(unavailable instanceof kind, code);
      assert.equal(unavailable.name, kind.name, code);
      assert.equal(unavailable.path, file);
      assert.equal(unavailable.cause, error);
      assert.match(unavailable.message, /cannot be opened/);
    }
  },
);

function thrown(fail: () => unknown): unknown {
  try {
    fail();
  } catch (error) {
    return error;
  }
  assert.fail('the call did not throw');
}

// Starts a second program that opens the database, takes the write lock,
// holds it for the given time, and then commits. It resolves when the lock is
// held.
async function holdWriteLock(path: string, milliseconds: number) {
  return holdLock(
    path,
    milliseconds,
    `open(${JSON.stringify(path)})`,
    'BEGIN IMMEDIATE',
  );
}

// The child opens the database with the given expression (it can use open,
// the journals, and DatabaseSync of node:sqlite), runs the statement that
// takes the lock, holds it for the given time, and then ends the transaction.
async function holdLock(
  path: string,
  milliseconds: number,
  opening: string,
  statement: string,
) {
  const index = new URL('./index.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { DatabaseSync } from 'node:sqlite';
      import { open, UnchangedJournal } from ${JSON.stringify(index)};
      const owner = ${opening};
      owner.exec(${JSON.stringify(statement)});
      owner.prepare('SELECT count(*) FROM sqlite_schema').get();
      process.stdout.write('locked\\n');
      setTimeout(() => { owner.exec('COMMIT'); owner.close(); }, ${milliseconds});`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const [line] = await once(child.stdout, 'data');
  assert.equal(String(line), 'locked\n');
  return child;
}

test('with no timeout, an owner waits out the write lock of another program', async () => {
  await using dir = await new TemporaryFiles().directory('open-');
  const path = join(dir.path, 'notes.sqlite');
  open(path).close();
  const other = await holdWriteLock(path, 2000);
  try {
    const started = performance.now();
    using owner = open(path);

    owner.exec('CREATE TABLE notes (title TEXT)');

    assert.ok(performance.now() - started >= 1500, 'the owner did not wait');
    assert.ok(
      owner.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'notes'").get(),
    );
  } finally {
    await once(other, 'exit');
  }
});

test('with timeout 0, an owner fails at once on the write lock of another program', async () => {
  await using dir = await new TemporaryFiles().directory('open-');
  const path = join(dir.path, 'notes.sqlite');
  open(path).close();
  const other = await holdWriteLock(path, 1000);
  try {
    using owner = open(path, { timeout: 0 });

    assert.throws(
      () => owner.exec('CREATE TABLE notes (title TEXT)'),
      (error: unknown) => {
        assert.ok(Error.isError(error) && 'errcode' in error);
        assert.equal(error.errcode, 5);
        return true;
      },
    );
  } finally {
    await once(other, 'exit');
  }
});

test('a database in memory has no file, so it gets no journal, and works', () => {
  for (const path of [':memory:', '', 'file::memory:?cache=shared']) {
    using database = open(path);

    database.exec(
      "CREATE TABLE notes (title TEXT); INSERT INTO notes VALUES ('first')",
    );

    assert.deepEqual(
      database
        .prepare('SELECT title FROM notes')
        .all()
        .map((row) => row.title),
      ['first'],
      JSON.stringify(path),
    );
  }
});

test('open applies a journal that the caller writes', async () => {
  await using dir = await new TemporaryFiles().directory('open-');
  class Stamped implements Journal {
    apply(database: DatabaseSync): void {
      database.exec('PRAGMA user_version = 7');
    }
  }

  using owner = open(join(dir.path, 'notes.sqlite'), {
    journal: new Stamped(),
  });

  assert.equal(owner.prepare('PRAGMA user_version').get()?.user_version, 7);
});

test('open gives a DatabaseSync, and takes the options and the paths of new DatabaseSync', async () => {
  await using dir = await new TemporaryFiles().directory('open-');
  const path = join(dir.path, 'notes.sqlite');

  using owner = open(path, { readBigInts: true, returnArrays: true });
  owner.exec('CREATE TABLE notes (id INTEGER); INSERT INTO notes VALUES (1)');

  assert.ok(owner instanceof DatabaseSync);
  assert.deepEqual(owner.prepare('SELECT id FROM notes').get(), [1n]);
  using byUrl = open(pathToFileURL(join(dir.path, 'url.sqlite')));
  assert.equal(byUrl.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  for (const other of [
    `file:${path}?cache=private`,
    pathToFileURL(path),
    Buffer.from(path),
  ]) {
    using reader = open(other, { readOnly: true });
    assert.equal(
      reader.prepare('SELECT count(*) AS notes FROM notes').get()?.notes,
      1,
      String(other),
    );
  }
});

test('UnchangedJournal opens a lock file that another program holds, with no wait', async () => {
  await using dir = await new TemporaryFiles().directory('open-');
  const path = join(dir.path, 'lock');
  // A lock file, as @zukhruf/fs holds it: no journal of its own on disk, and
  // an exclusive transaction while it holds the lock.
  const other = await holdLock(
    path,
    300,
    `new DatabaseSync(${JSON.stringify(path)})`,
    'PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE',
  );
  try {
    using lock = open(path, { journal: new UnchangedJournal(), timeout: 0 });

    assert.equal(lock.location(), path);
  } finally {
    await once(other, 'exit');
  }
});

test('RollbackJournal changes a write-ahead log to the rollback journal, and leaves no -wal or -shm', async () => {
  await using dir = await new TemporaryFiles().directory('open-');
  const path = join(dir.path, 'staging.sqlite');
  open(path).close();

  {
    using staging = open(path, { journal: new RollbackJournal() });

    assert.equal(
      staging.prepare('PRAGMA journal_mode').get()?.journal_mode,
      'delete',
    );
    assert.equal(staging.prepare('PRAGMA synchronous').get()?.synchronous, 2);
    staging.exec('CREATE TABLE notes (title TEXT)');
  }

  assert.deepEqual(readdirSync(dir.path), ['staging.sqlite']);
});

test('the default journal is a write-ahead log with a size limit, and leaves no -wal or -shm after the last close', async () => {
  await using dir = await new TemporaryFiles().directory('open-');
  const path = join(dir.path, 'notes.sqlite');
  {
    using owner = open(path);

    assert.equal(
      owner.prepare('PRAGMA journal_mode').get()?.journal_mode,
      'wal',
    );
    assert.equal(
      owner.prepare('PRAGMA journal_size_limit').get()?.journal_size_limit,
      67108864,
    );
    assert.equal(owner.prepare('PRAGMA synchronous').get()?.synchronous, 1);
    owner.exec('CREATE TABLE notes (title TEXT)');
  }

  assert.deepEqual(readdirSync(dir.path), ['notes.sqlite']);
});

test('an owner opens a database in a rollback journal that another program reads, and changes it to a write-ahead log', async () => {
  await using dir = await new TemporaryFiles().directory('open-');
  const path = join(dir.path, 'notes.sqlite');
  {
    using vendor = new DatabaseSync(path);
    vendor.exec('CREATE TABLE notes (title TEXT)');
  }
  // The other program holds a read transaction of the rollback journal.
  const other = await holdLock(
    path,
    1000,
    `new DatabaseSync(${JSON.stringify(path)}, { readOnly: true })`,
    'BEGIN',
  );
  try {
    const started = performance.now();
    using owner = open(path);

    assert.ok(performance.now() - started >= 700, 'the owner did not wait');
    assert.equal(
      owner.prepare('PRAGMA journal_mode').get()?.journal_mode,
      'wal',
    );
  } finally {
    await once(other, 'exit');
  }
});

test('after the journal step, the owner can load an extension only when the caller allows it', async () => {
  await using dir = await new TemporaryFiles().directory('open-');
  const suffix =
    process.platform === 'darwin'
      ? 'dylib'
      : process.platform === 'win32'
        ? 'dll'
        : 'so';
  const library = new URL(
    `../lib/${process.platform}-${process.arch}/persist_wal.${suffix}`,
    import.meta.url,
  );

  {
    using owner = open(join(dir.path, 'closed.sqlite'), {
      journal: new PersistentWriteAheadLog(),
    });
    assert.throws(
      () => owner.loadExtension(fileURLToPath(library)),
      /extension loading is not allowed/,
    );
  }
  using allowed = open(join(dir.path, 'allowed.sqlite'), {
    journal: new PersistentWriteAheadLog(),
    allowExtension: true,
  });
  allowed.loadExtension(fileURLToPath(library));
});

test('the types refuse a journal for a reader and the option open, and take the other options of new DatabaseSync', () => {
  // typecheck proves this test: an @ts-expect-error that has no error fails it.
  const illegal = [
    // @ts-expect-error A reader never changes the journal.
    () => open(':memory:', { readOnly: true, journal: new WriteAheadLog() }),
    // @ts-expect-error open always opens the connection.
    () => open(':memory:', { open: false }),
  ];
  const legal = [
    () => open(':memory:', { readOnly: true, timeout: 1, readBigInts: true }),
    () =>
      open(':memory:', {
        journal: new RollbackJournal(),
        timeout: 0,
        returnArrays: true,
        allowExtension: true,
        enableForeignKeyConstraints: false,
        allowUnknownNamedParameters: true,
      }),
  ];

  assert.equal(illegal.length, 2);
  for (const make of legal) make().close();
});

for (const [name, journal] of [
  ['WriteAheadLog', () => new WriteAheadLog({ pageSize: 32768 })],
  [
    'PersistentWriteAheadLog',
    () => new PersistentWriteAheadLog({ pageSize: 32768 }),
  ],
] as const) {
  test(`${name} with a page size gives a new file that page size, in a write-ahead log`, async () => {
    await using dir = await new TemporaryFiles().directory('open-');

    using owner = open(join(dir.path, 'vectors.sqlite'), {
      journal: journal(),
    });

    assert.equal(owner.prepare('PRAGMA page_size').get()?.page_size, 32768);
    assert.equal(
      owner.prepare('PRAGMA journal_mode').get()?.journal_mode,
      'wal',
    );
  });
}

for (const [name, journal] of [
  [
    'WriteAheadLog',
    (options?: { readonly synchronous: 'full' }) => new WriteAheadLog(options),
  ],
  [
    'PersistentWriteAheadLog',
    (options?: { readonly synchronous: 'full' }) =>
      new PersistentWriteAheadLog(options),
  ],
] as const) {
  test(`${name} syncs at checkpoints by default, so a commit does not wait for the disk`, async () => {
    await using dir = await new TemporaryFiles().directory('open-');

    using owner = open(join(dir.path, 'notes.sqlite'), { journal: journal() });

    assert.equal(owner.prepare('PRAGMA synchronous').get()?.synchronous, 1);
  });

  test(`${name} with synchronous 'full' syncs at each commit, so a commit survives a power loss`, async () => {
    await using dir = await new TemporaryFiles().directory('open-');

    using owner = open(join(dir.path, 'jobs.sqlite'), {
      journal: journal({ synchronous: 'full' }),
    });

    assert.equal(owner.prepare('PRAGMA synchronous').get()?.synchronous, 2);
  });
}

test('a page size does not change an existing write-ahead log, which keeps its own page size', async () => {
  await using dir = await new TemporaryFiles().directory('open-');
  const path = join(dir.path, 'vectors.sqlite');
  {
    using first = open(path);
    first.exec('CREATE TABLE vectors (id INTEGER)');
  }

  using owner = open(path, { journal: new WriteAheadLog({ pageSize: 32768 }) });

  assert.equal(owner.prepare('PRAGMA page_size').get()?.page_size, 4096);
});
