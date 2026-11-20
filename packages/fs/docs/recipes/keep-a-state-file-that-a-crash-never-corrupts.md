# Recipe: Keep a state file that a crash never corrupts

**Use case.** A tool keeps its state in a JSON file, for example the last run of each job, or a ledger of the messages that it sent. Each run reads the file, changes the state, and writes the file again. `writeFile` of `node:fs/promises` opens the file with the flag `w`, so it truncates the file first and then writes the new content ([Node.js file system flags](https://nodejs.org/api/fs.html#file-system-flags)). When the process stops during the write, the file is empty, or it holds only a part of the new content. The next run cannot parse the file, and the state is gone. `atomicWrite` fills a draft beside the path and replaces the file in one step with a rename, so the file holds the old state or the new state.

**What you need.** `atomicWrite` to write the state, and `isErrno` to tell that the first run finds no file.

## The steps

1. Read the state with `readFile`. When the read rejects with the error code `ENOENT`, no file is at the path: start from an empty state. Let each other error reach the caller.
2. Change the state.
3. Write the state with `atomicWrite(path, content, { clock: globalThis })`.

## The program

A worker process reads, changes and writes its state file in a loop, and the program stops it with `SIGKILL`. The program does this 20 times with `writeFile` and 20 times with `atomicWrite`, each time at a slightly later moment. After each kill, it reads the file and counts the files that do not parse.

```ts title="state-file.ts"
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { TemporaryFiles, atomicWrite, isErrno } from '@zukhruf/fs';

interface State {
  runs: number;
  seen: string[];
}

async function readState(path: string): Promise<State> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as State;
  } catch (error) {
    // The first run finds no file: it starts from an empty state.
    if (isErrno(error, 'ENOENT')) return { runs: 0, seen: [] };
    throw error;
  }
}

async function writeState(
  path: string,
  state: State,
  writer: 'writeFile' | 'atomicWrite',
) {
  const content = `${JSON.stringify(state)}\n`;
  if (writer === 'writeFile') await writeFile(path, content);
  else await atomicWrite(path, content, { clock: globalThis });
}

const [role, writer, path] = process.argv.slice(2);

if (role === 'worker') {
  // The worker keeps its state up to date until a SIGKILL stops it.
  for (;;) {
    const state = await readState(path);
    state.runs += 1;
    state.seen.push(`item-${state.runs}`.padEnd(64, '.'));
    await writeState(path, state, writer as 'writeFile' | 'atomicWrite');
  }
}

await using folder = await new TemporaryFiles().directory('state-');
const kills = 20;

for (const name of ['writeFile', 'atomicWrite']) {
  let corrupt = 0;
  let empty = 0;
  for (let kill = 0; kill < kills; kill++) {
    const file = join(folder.path, `${name}-${kill}.json`);
    // A first state of 20,000 items, so that each write takes some time.
    await writeFile(
      file,
      JSON.stringify({
        runs: 0,
        seen: Array.from({ length: 20_000 }, (_, i) =>
          `seed-${i}`.padEnd(64, '.'),
        ),
      }),
    );
    const worker = spawn(
      process.execPath,
      [...process.execArgv, import.meta.filename, 'worker', name, file],
      { stdio: 'inherit' },
    );
    await delay(300 + kill * 7);
    worker.kill('SIGKILL');
    await once(worker, 'exit');
    const text = await readFile(file, 'utf8');
    try {
      JSON.parse(text);
    } catch {
      corrupt += 1;
      if (text.length === 0) empty += 1;
    }
  }
  console.log(
    `${name}: ${corrupt} of ${kills} kills left a file that does not parse: ${empty} empty, ${corrupt - empty} with a part of the new state`,
  );
}
```

Run it from a folder outside the packages, with the workspace's `node_modules` linked into it:

```sh
node --conditions=@zukhruf/source state-file.ts
```

Output (the counts of `writeFile` change from run to run, because each kill stops the worker at a different moment):

```
writeFile: 2 of 20 kills left a file that does not parse: 0 empty, 2 with a part of the new state
atomicWrite: 0 of 20 kills left a file that does not parse: 0 empty, 0 with a part of the new state
```

## What the output shows

- **A kill during `writeFile` corrupts the state.** A kill during the write leaves the start of the new state, which does not parse. A kill after the truncation and before the first byte leaves an empty file; in this run, no kill fell in that short time.
- **A kill during `atomicWrite` never corrupts the state.** The worker writes the new state into a draft. Only the rename puts the draft at the path, and the rename is one step. Thus each file parses: it holds the state of the last write that finished. `src/replace-in-one-step.test.ts` proves that a write puts the new content in place with one rename of a draft beside the path.

## Things to know

- **A kill can leave a draft beside the file.** A write removes its draft when it fails, but a `SIGKILL` stops the process before that step. A draft has a unique name, so it never blocks a later write ([A failed write leaves no draft](../../README.md#a-failed-write-leaves-no-draft)).
- **Use `durableWrite` when the state must survive a power loss.** After a rename, the operating system can keep the new content in memory for some time. `durableWrite` returns only after the new content and the rename are on the disk ([Make the replacement durable](../../README.md#make-the-replacement-durable)).
- **Give `globalThis` as the clock in production.** A write waits on the clock only on Windows, between two tries of a rename that Windows refuses for now ([ADR 0005](../adr/0005-a-write-waits-on-the-clock-that-the-caller-gives.md)).
- **One process at a time must change the state.** Two processes that read the file at the same time and then write it lose one of the two changes. Hold a `FileLock` while you read, change and write the state ([Lock a file](../../README.md#lock-a-file)).
