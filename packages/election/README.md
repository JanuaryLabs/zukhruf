# @zukhruf/election

Candidates campaign for one claim, and the candidate that wins it leads for one term. Each term has an epoch that is higher than the epoch of each earlier term, so a newer leader always outranks an older one. A term ends when the leader resigns or its process dies. With a backend of leases, a term can also be lost while the leader still runs, and the term tells its leader so.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment.

```sh
npm install @zukhruf/election
```

## Elect a leader of one host

`SqliteElection` elects one leader among the processes of one host that use the same directory. The claim is an exclusive SQLite transaction on `claimFile`. The operating system holds that lock until the leader's process dies, so a dead leader frees the claim at once, and a living leader never loses it.

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteElection } from '@zukhruf/election';

const directory = await mkdtemp(join(tmpdir(), 'jobs-'));
const election = new SqliteElection({
  directory,
  claimFile: 'jobs.lock',
  epochFile: 'jobs.epoch',
});

const first = await election.campaign();
console.log('first term:', first?.epoch);
console.log('a second candidate wins:', await election.campaign());

await first?.resign();
await using second = await election.campaign({ timeout: 1000 });
console.log('next term:', second?.epoch);
await rm(directory, { recursive: true, force: true });
```

Output:

```
first term: 1n
a second candidate wins: undefined
next term: 2n
```

- `campaign({ timeout, signal })` resolves with a `Term`, or with `undefined` when another candidate still leads after `timeout` milliseconds. Without a `timeout`, it tries once. When `signal` aborts, it rejects with `signal.reason`, and a claim that it won meanwhile is given up.
- `claimFile` and `epochFile` are files in `directory`. Candidates with the same directory and the same file names are one group. Never delete `claimFile` while candidates run: a new file lets a second leader win.
- The directory must be on a local file system. On a network file system, `campaign` rejects with `NetworkDirectoryError`.
- `pollInterval` is the time between two tries, in milliseconds. It defaults to 10. A try never blocks the process.

## The term

- `term.epoch` is the number of the term. Pass it into a fencing token, for example `EpochTokenSource` of `@zukhruf/mutex`, so that a resource can refuse an older leader. Each epoch is below 2^31.
- `term.resign()` ends the term and gives the claim up. A second call waits for the first. `await using` resigns at the end of its scope.
- `term.signal` aborts with `TermLostError` when the term is lost while its leader still runs. It does not abort when the leader resigns.

A leader that acts for the group must stop when `term.signal` aborts, because another candidate can lead then. `SqliteElection` never loses a living term, so its signal never aborts. A backend of leases can lose one.

## Write a backend

`LeaderElection` is an abstract class. It runs the campaign, and it owns the term. A backend is a subclass that implements five steps for its claim:

| Step                      | What it does                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open(signal)`            | Prepares one attempt, for example a connection. The campaign calls `tryClaim` on it again and again.                                                |
| `tryClaim(claim, signal)` | Tries the claim once. Resolves with the epoch of the term it won, or `undefined` while another candidate holds the claim.                           |
| `watch(claim, lose)`      | Watches a won claim for as long as its term lasts. Calls `lose` when the backend takes the claim away. Returns a `Disposable` that stops the watch. |
| `release(claim)`          | Gives a won claim up when the leader resigns.                                                                                                       |
| `close(claim)`            | Frees the resources of an attempt, at each end.                                                                                                     |

A backend must keep four rules:

1. `tryClaim` gives the epoch in the same step that wins the claim. Each epoch is higher than each earlier one, and below 2^31.
2. `watch` calls `lose` before the backend can give the claim to another candidate. For a lease, renew it well before it expires, and count the time on a monotonic clock. Then an old leader stops before a new one starts.
3. The campaign never calls `release` after a loss, because the claim can be another candidate's then.
4. The campaign calls `close` after each end: a won term, a lost term, a failed attempt, or an attempt that never won.

This backend elects among the candidates of one process. Its claim is an entry in a map:

```ts
import { LeaderElection } from '@zukhruf/election';

const holders = new Map<string, bigint>();
let lastEpoch = 0n;

class MapElection extends LeaderElection<string> {
  readonly #name: string;

  constructor(name: string) {
    super(10);
    this.#name = name;
  }

  protected async open() {
    return this.#name;
  }

  protected async tryClaim(name: string) {
    if (holders.has(name)) return undefined;
    lastEpoch += 1n;
    holders.set(name, lastEpoch);
    return lastEpoch;
  }

  // Nothing takes an entry of the map away, so there is nothing to watch.
  protected watch() {
    return { [Symbol.dispose]() {} };
  }

  protected async release(name: string) {
    holders.delete(name);
  }

  protected async close() {}
}

const term = await new MapElection('jobs').campaign();
console.log('leader:', term?.epoch);
console.log('rival:', await new MapElection('jobs').campaign());
await term?.resign();
console.log(
  'rival after the resign:',
  (await new MapElection('jobs').campaign())?.epoch,
);
```

Output:

```
leader: 1n
rival: undefined
rival after the resign: 2n
```

The socket lock store of `@zukhruf/mutex` and `@zukhruf/single-flight` do not use this package yet. Each of them keeps its own copy of the election ([copied code](./docs/copied-code.md)). When they use it, they will use `SqliteElection`. Their leaders serve the other candidates over a socket in the directory, so they work on one host only, also with another backend.

## Errors

| Error                   | When                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `NetworkDirectoryError` | The directory of a `SqliteElection` is on a network file system. It is the class of `@zukhruf/fs`.     |
| `TermLostError`         | The reason of `term.signal` when the backend took the claim away. Its `cause` is the backend's reason. |
| `signal.reason`         | A campaign rejects with it when its signal aborts.                                                     |

## Documentation

- [ADR 0001: Leader election is a package, and each backend is a subclass of one campaign](./docs/adr/0001-leader-election-is-a-package-and-each-backend-is-a-subclass.md)
- [Code copied into this package](./docs/copied-code.md)

## Development

This package is part of the [zukhruf](../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run election:test        # builds, then runs the tests in src/
npx nx run election:typecheck   # formats, lints, then type checks
npx nx run election:build       # compiles src/ to dist/
```

```
src/
  leader-election.ts     LeaderElection: the campaign, and the steps of a backend
  term.ts                Term: the epoch, the signal of a lost term, and resign
  term-lost-error.ts     TermLostError
  sqlite/                SqliteElection: the backend of one host
  testing/               the helpers that start candidate processes in the tests
```
