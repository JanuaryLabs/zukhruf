# Recipe: Read the database of another program, and translate an unavailable file at your boundary

**Use case.** Your program reads a database that another program, the owner, writes. Your program does not make the file, and it cannot make the system give access to it. So the file can be missing, because the owner did not make it yet, or denied, because a file mode, a sandbox or a privacy rule keeps your process from it. Your callers need an answer in the words of your program: "nothing here yet", or "give this program access". They must not catch the error of a package that they do not import. Without `open`, each reader catches the error of `new DatabaseSync`, and must find out which `SQLITE_CANTOPEN` (14) is which case.

**What you need.** `open` with `readOnly: true`, and the classes `UnavailableError` and `MissingError`.

## The steps

1. Open a reader with `open(path, { readOnly: true })`, and read in the same `try` block. A reader closes with `using` when the block ends.
2. Catch `MissingError` first, and give the answer of your program for a database that is not there yet, for example `null`.
3. Catch `UnavailableError` next, and throw the error of your program with the error of the package as `cause`. This catch also gets each `DeniedError`, and each unavailable file that the system does not decide.
4. Throw all other errors again. They are not unavailable: for example a file that is not a database.

## The program

The program reads the titles of the notes at one path four times: before the owner makes the database, after the owner writes it, while the file has mode 000, and from a text file. Run it as a user that is not root, because root can open a file with mode 000.

```ts title="read-notes.ts"
import { writeFileSync } from 'node:fs';
import { chmod, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MissingError,
  UnavailableError,
  open,
  sqliteResultCode,
} from '@zukhruf/sqlite-open';

// The error of this program. Its callers catch it, not the error of the package.
class NotesUnavailableError extends Error {
  constructor(options: ErrorOptions) {
    super(
      'The notes cannot be read: give this program access to them',
      options,
    );
    this.name = 'NotesUnavailableError';
  }
}

// The titles of the notes, or null while the owner has not made the database.
function readNotes(path: string): string[] | null {
  try {
    using reader = open(path, { readOnly: true });
    return reader
      .prepare('SELECT title FROM notes')
      .all()
      .map((row) => String(row.title));
  } catch (error) {
    if (error instanceof MissingError) return null;
    if (error instanceof UnavailableError)
      throw new NotesUnavailableError({ cause: error });
    throw error;
  }
}

function attempt(label: string, path: string) {
  try {
    console.log(label, readNotes(path));
  } catch (error) {
    if (error instanceof NotesUnavailableError) {
      const cause = error.cause as UnavailableError;
      console.log(
        label,
        `${error.name}: ${error.message} (cause: ${cause.name})`,
      );
    } else console.log(label, 'the error of SQLite:', sqliteResultCode(error));
  }
}

await using scratch = await mkdtempDisposable(join(tmpdir(), 'notes-'));
const path = join(scratch.path, 'notes.sqlite');

attempt('1. before the owner makes it:', path);

{
  // The other program, the owner, makes the database and writes it.
  using owner = open(path);
  owner.exec(`CREATE TABLE notes (title TEXT);
    INSERT INTO notes VALUES ('first'), ('second')`);
}
attempt('2. after the owner writes it:', path);

// The system denies this process access to the file.
await chmod(path, 0o000);
attempt('3. when the system denies it:', path);
await chmod(path, 0o644);

// A file that is not a database opens, and fails at the first read.
const text = join(scratch.path, 'text.sqlite');
writeFileSync(text, 'not a database, but a text file. '.repeat(200));
attempt('4. a file that is not a database:', text);
```

Output on macOS, with Node 26.13:

```
1. before the owner makes it: null
2. after the owner writes it: [ 'first', 'second' ]
3. when the system denies it: NotesUnavailableError: The notes cannot be read: give this program access to them (cause: DeniedError)
4. a file that is not a database: the error of SQLite: { code: 26, extendedCode: 26 }
```

## What the output shows

- **1.** The file is not there, so `open` throws a `MissingError`, and `readNotes` gives `null`. The caller of `readNotes` does not know the package.
- **2.** The owner wrote the database, so the reader reads its rows.
- **3.** The file has mode 000, so `open` throws a `DeniedError`. `readNotes` throws its own `NotesUnavailableError`, and keeps the `DeniedError` as `cause`. The `cause` has the `path`, and its own `cause` is the error of SQLite. A program that prints the error with its causes shows all three.
- **4.** A reader does no step after the open, so a text file opens. The first read fails with `SQLITE_NOTADB` (26). This error is not unavailable, so `readNotes` throws it again, and `sqliteResultCode` reads its code. The test "a file that is not a database is the error of SQLite, not an UnavailableError" in `src/open.test.ts` shows this for a reader and for an owner.

## Things to know

- **Catch `MissingError` before `UnavailableError`.** `MissingError` and `DeniedError` are subclasses of `UnavailableError`, so a catch of `UnavailableError` first also gets the missing file ([ADR 0008](../adr/0008-a-missing-file-and-a-denied-file-are-two-classes.md)).
- **A plain `UnavailableError` is a case that the system does not decide.** For example, the file opens in `node:fs` but not in SQLite. Step 3 treats it as a file that the program cannot read. Do not look again with `existsSync` or `stat`: `stat` succeeds on a file that the system denies ([ADR 0008](../adr/0008-a-missing-file-and-a-denied-file-are-two-classes.md)).
- **The package throws its own `UnavailableError`, and the host translates it.** The host keeps the error of the package as `cause` ([The rules](../../README.md#the-rules)). One class of the error is in this package, so a catch works for a reader that another zukhruf package opens too ([ADR 0001](../adr/0001-one-package-opens-the-reader-and-owns-unavailable-error.md)).
- **A host that has a list of configuration errors can put `UnavailableError` in it.** Then the host shows each unavailable file as a problem that the user fixes, for example with a grant of access, and not as a failure of the program.
- **A reader that cannot write the folder needs persistent WAL.** In a write-ahead log, such a reader cannot open the database after the owner closes it, because SQLite deletes the `-wal` and `-shm` files. The owner selects `PersistentWriteAheadLog` ([ADR 0003](../adr/0003-persistent-wal-through-a-native-library.md)).
- **Mode 000 stands in for a privacy denial of macOS.** SQLite gives the same `SQLITE_CANTOPEN` (14) for both, and `node:fs` gives `EACCES` or `EPERM` ([ADR 0008](../adr/0008-a-missing-file-and-a-denied-file-are-two-classes.md)). The tests of `src/open.test.ts` use it the same way.
