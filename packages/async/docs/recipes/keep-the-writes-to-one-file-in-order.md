# Recipe: Keep the writes to one file in order

**Use case.** A process appends records to one file, for example telemetry events or the rows of a dataset. Many callers write at the same time, and the records must land in the order of the calls. A common fix is a chain of promises: each write waits for the write before it. But when one write fails, the chain rejects, and each write after it fails too. Three consumers had this defect, and moved to `Lock` (#4525).

**What you need.** One `Lock` for each file.

## The steps

1. Create one `Lock` for the file.
2. Do each write in `writes.run(() => write(…), { signal: undefined })`.
3. Handle the rejection of each call. A failed write rejects only its own call.

## The problem

The program writes four events through a chain of promises. `JSON.stringify` throws on a `bigint`, so the second write fails.

```ts title="broken-chain.ts"
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'broken-chain-'));
const file = join(directory, 'events.jsonl');

// Each write waits for the write before it.
let writes = Promise.resolve();
function write(event: object): Promise<void> {
  writes = writes.then(() => appendFile(file, `${JSON.stringify(event)}\n`));
  return writes;
}

// JSON.stringify throws on a bigint, so the second write fails.
const results = await Promise.allSettled([
  write({ event: 1 }),
  write({ event: 2, size: 2n }),
  write({ event: 3 }),
  write({ event: 4 }),
]);
console.log(
  results.map((result) =>
    result.status === 'fulfilled'
      ? 'written'
      : `failed: ${result.reason.message}`,
  ),
);
console.log((await readFile(file, 'utf8')).trim().split('\n'));
await rm(directory, { recursive: true, force: true });
```

Output:

```
[
  'written',
  'failed: Do not know how to serialize a BigInt',
  'failed: Do not know how to serialize a BigInt',
  'failed: Do not know how to serialize a BigInt'
]
[ '{"event":1}' ]
```

Only the first event is in the file. The writes of events 3 and 4 never ran, and their calls rejected with the error of event 2.

## The solution

The program writes the same four events through a `Lock`.

```ts title="ordered-writes.ts"
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Lock } from '@zukhruf/async';

const directory = await mkdtemp(join(tmpdir(), 'ordered-writes-'));
const file = join(directory, 'events.jsonl');

// One lock for each file: the writes run one at a time, in the order of the calls.
const writes = new Lock();
function write(event: object): Promise<void> {
  return writes.run(() => appendFile(file, `${JSON.stringify(event)}\n`), {
    signal: undefined,
  });
}

// JSON.stringify throws on a bigint, so the second write fails.
const results = await Promise.allSettled([
  write({ event: 1 }),
  write({ event: 2, size: 2n }),
  write({ event: 3 }),
  write({ event: 4 }),
]);
console.log(
  results.map((result) =>
    result.status === 'fulfilled'
      ? 'written'
      : `failed: ${result.reason.message}`,
  ),
);
console.log((await readFile(file, 'utf8')).trim().split('\n'));
await rm(directory, { recursive: true, force: true });
```

Output:

```
[
  'written',
  'failed: Do not know how to serialize a BigInt',
  'written',
  'written'
]
[ '{"event":1}', '{"event":3}', '{"event":4}' ]
```

## Why it works

`run` holds the lock while the work runs, and frees it when the work ends, also when the work fails. The other callers wait in the line, and they get the lock in the order in which they came. Thus the writes run one at a time, in the order of the calls. A failed write rejects `run` with its error, and the next caller then gets the lock. See [Let one caller at a time do a thing, with a lock](../../README.md#let-one-caller-at-a-time-do-a-thing-with-a-lock) and [ADR 0013](../adr/0013-a-lock-is-a-semaphore-of-one-that-grants-in-order-and-a-cancel-leaves-the-line.md).

The test `src/lock.test.ts` proves both facts: "runs work one at a time, in the order of the calls", and "a run whose work fails rejects with its error and frees the lock for the next run".

## Things to know

- **Handle the rejection of each call.** A rejection that no caller handles ends the process. The file telemetry of `@deepagents/context` gives each failed write to its `onWriteError`, so a failed write never affects the operation that it records (`packages/context/src/lib/telemetry/file/file-telemetry.ts`).
- **A lock puts in order only the writes of one process.** For writes from more than one process, use a key of `@zukhruf/mutex`.
- **Use one lock for each file or each session, not one for all.** The writes to two files do not wait for each other. elt makes one lock for each session that stores the rows of a computed dataset (`packages/destinations/postgresql/src/computed-dataset.ts`).
- **To hold the lock for more than one call**, for example to read a file and then write it, acquire it: `using held = await writes.acquire({ signal: undefined })`.
- **To limit the wait, give the signal of a `timeout`**: `using limit = timeout(5_000, { clock: globalThis })`, then `writes.run(work, { signal: limit.signal })`. See [Stop a wait after a time](../../README.md#stop-a-wait-after-a-time). When the signal aborts while the caller waits, the caller leaves the line, and its work never starts.
- **Other consumers.** finetuning orders the writes of a dataset collection with a lock (commit `56aef19`, `apps/finetuning/src/webmcp-collector/collect.ts`), and theagentlab orders the writes of its watermark file, so that an earlier watermark never replaces a later one (`apps/whatsapp-bot/src/waha/catch-up.ts`).
