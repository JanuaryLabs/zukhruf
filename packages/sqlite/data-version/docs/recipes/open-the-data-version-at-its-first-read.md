# Recipe: Open the data version at its first read

**Use case.** A change watcher of `@zukhruf/async` reads the data version of a database that an owner writes. `new DataVersion(path)` opens its read-only connection in its constructor ([src/data-version.ts](../../src/data-version.ts)). When the owner has not made the database yet, or this process cannot open it, the constructor throws `UnavailableError`, and the host cannot make the gauge at all. A gauge that makes the `DataVersion` at its first read can be made at any time, and each check of the watcher tries to open the database again.

**What you need.** `DataVersion` and `UnavailableError` of this package, and `Gauge` and `ChangeWatcher` of `@zukhruf/async`.

## The steps

1. Write a gauge with two states. `Closed` holds no `DataVersion`. `Opened` holds one.
2. In `Closed`, make the `DataVersion` at each read. When it throws `UnavailableError`, give `'unavailable'` and stay `Closed`. Else read it, and go to `Opened`.
3. In `Opened`, give `current`. When `current` throws `UnavailableError`, dispose the `DataVersion`, give `'unavailable'`, and go to `Closed`.
4. Give the gauge to a `ChangeWatcher`.

## The program

The program first shows that `new DataVersion` throws before the owner makes the database. Then a change watcher reads the gauge, and the owner makes the database, commits, and replaces the file with one that this process cannot read. Each line gives what the owner did before a check, and the outcome of that check.

```ts title="first-read.ts"
import { chmod, mkdtempDisposable, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChangeWatcher, Gauge } from '@zukhruf/async';
import { DataVersion, UnavailableError } from '@zukhruf/sqlite-data-version';
import { open } from '@zukhruf/sqlite-open';

type Reading = number | 'unavailable';

interface VersionState extends Disposable {
  read(): { readonly value: Reading; readonly state: VersionState };
}

// No DataVersion is open. Each read tries to make one.
class Closed implements VersionState {
  readonly #open: () => DataVersion;

  constructor(open: () => DataVersion) {
    this.#open = open;
  }

  read() {
    let version: DataVersion;
    try {
      version = this.#open();
    } catch (error) {
      if (error instanceof UnavailableError)
        return { value: 'unavailable' as const, state: this };
      throw error;
    }
    return new Opened(this.#open, version).read();
  }

  [Symbol.dispose](): void {}
}

// A DataVersion is open. Each read gives its current value.
class Opened implements VersionState {
  readonly #open: () => DataVersion;
  readonly #version: DataVersion;

  constructor(open: () => DataVersion, version: DataVersion) {
    this.#open = open;
    this.#version = version;
  }

  read() {
    try {
      return { value: this.#version.current, state: this };
    } catch (error) {
      // The owner replaced the file with one that this process cannot open.
      if (!(error instanceof UnavailableError)) throw error;
      this.#version[Symbol.dispose]();
      return { value: 'unavailable' as const, state: new Closed(this.#open) };
    }
  }

  [Symbol.dispose](): void {
    this.#version[Symbol.dispose]();
  }
}

// The gauge that a change watcher reads. Making it opens nothing.
class VersionAtFirstRead extends Gauge<Reading> implements Disposable {
  #state: VersionState;

  constructor(open: () => DataVersion) {
    super();
    this.#state = new Closed(open);
  }

  protected async read(): Promise<Reading> {
    const { value, state } = this.#state.read();
    this.#state = state;
    return value;
  }

  [Symbol.dispose](): void {
    this.#state[Symbol.dispose]();
  }
}

await using scratch = await mkdtempDisposable(join(tmpdir(), 'first-read-'));
const path = join(scratch.path, 'notes.sqlite');

try {
  using _ = new DataVersion(path);
} catch (error) {
  if (!(error instanceof UnavailableError)) throw error;
  console.log(`new DataVersion before the owner starts: ${error.name}`);
}

using version = new VersionAtFirstRead(() => new DataVersion(path));
const watcher = new ChangeWatcher([version], {
  interval: 10,
  timeout: 1_000,
  clock: globalThis,
});

let owner: ReturnType<typeof open> | undefined;
// What the owner does before each check, after the first.
const steps: [string, () => Promise<void>][] = [
  [
    'the owner makes the database',
    async () => {
      owner = open(path);
      owner.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)');
    },
  ],
  [
    'the owner commits',
    async () => {
      owner!.prepare('INSERT INTO notes (title) VALUES (?)').run('first');
    },
  ],
  ['the owner does nothing', async () => {}],
  [
    'the owner replaces the file with one this process cannot read',
    async () => {
      owner!.close();
      const next = join(scratch.path, 'next.sqlite');
      const made = open(next);
      made.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)');
      made.close();
      await chmod(next, 0o000);
      await rename(next, path);
    },
  ],
  ['the owner does nothing', async () => {}],
  [
    'the owner gives access again',
    async () => {
      await chmod(path, 0o644);
    },
  ],
];

const controller = new AbortController();
let what = 'nothing is there yet';
for await (const outcomes of watcher.watch(controller.signal)) {
  const outcome = outcomes.get(version)!;
  console.log(`${what}: ${outcome.state}`);
  const step = steps.shift();
  if (step === undefined) break;
  [what] = step;
  await step[1]();
}
```

Output, from a user that is not root (root can read a file of mode `000`):

```
new DataVersion before the owner starts: MissingError
nothing is there yet: changed
the owner makes the database: changed
the owner commits: changed
the owner does nothing: unchanged
the owner replaces the file with one this process cannot read: changed
the owner does nothing: unchanged
the owner gives access again: changed
```

## Why it works

- **Making the gauge opens nothing.** The constructor of `VersionAtFirstRead` makes only a `Closed` state. The first `DataVersion` comes at the first check.
- **`'unavailable'` is a value, not a failure.** `Closed` catches only `UnavailableError`, and gives `'unavailable'`. The watcher reads a value, so its first check gives `changed`, as for each gauge that it can read at the first check ([src/change-watcher.ts](../../../../async/src/change-watcher.ts)). A check that gives `'unavailable'` again gives `unchanged`.
- **The database that comes is a change.** The check after the owner made the database reads a number in place of `'unavailable'`, so the outcome is `changed`.
- **A replaced file that this process cannot open closes the `DataVersion`.** `current` opens the replaced file, and throws `UnavailableError` when SQLite cannot open it ([Errors](../../README.md#errors)). `Opened` disposes the `DataVersion` and goes back to `Closed`. The next check that can open the file reads a number again, and that is a change.

## Things to know

- **Two consumers write this gauge.** elt's `AppDatabaseVersion` (`packages/sdks/macos/app-database/src/app-database-version.ts`) has the `'unavailable'` state. context-compiler's `StoreVersion` (`apps/websets/src/definitions/store-version.ts`) has only `Closed` and `Opened`: its database is always there, so it has no `'unavailable'` state. The copy ledger of context-compiler (`apps/websets/docs/copied-code.md`, "A data version that opens at its first read") records the copy, and backlog #3998 extracts it when a third place needs it.
- **A `DataVersion` that opens again starts its number again.** Compare a data version only with an earlier value from the same `DataVersion` (see the glossary in [CONTEXT.md](../../CONTEXT.md)). The gauge gives `'unavailable'` between two `DataVersion` objects, so the watcher sees a change also when the new number equals the old one.
- **Other errors fail the check.** `Closed` and `Opened` throw each error that is not an `UnavailableError`. The watcher gives the outcome `failed` for that check. A `Closed` state stays `Closed`, so the next check tries to open the database again.
- **A path that this process cannot see is not unavailable.** When the owner deletes the file, `DataVersion` keeps its connection, and `current` gives no change ([Read the data version](../../README.md#read-the-data-version)). Only a file at the path that SQLite cannot open makes `current` throw.
- **For an exclusive owner, give `() => DataVersion.ofExclusiveOwner(path)`.** It throws `UnavailableError` when the file is missing or the system denies this process ([Observe an owner that lets no reader in](../../README.md#observe-an-owner-that-lets-no-reader-in)).
