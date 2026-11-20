# Recipe: Publish a pipe's address and connect to it from another program

**Use case.** A server program listens, and other programs of the computer must find it and connect to it. The other programs do not know the name of the pipe, and the server can crash at any time. The server publishes the path of its pipe in a record, and each client reads the record and connects. Two consumers do this today: `@zukhruf/sqlite-notify` writes the path in a row of its listener table (`src/listening.ts`), and `@zukhruf/election` writes it in its leader record (`src/sqlite/leader-pipe.ts`). `@zukhruf/pool` plans a third: the address of each waiting caller ([pool README](../../../pool/README.md)). Without a published path, each client must agree with the server on the default folder and the name.

**What you need.** `PipeEndpoint` for the server, `PipeAddress` for the client, and a record that both programs can read: here a JSON file.

## The steps

1. In the server, make a `PipeEndpoint` with a random plain name, and call `endpoint.listen`.
2. Write `endpoint.address.path` in the record.
3. In the client, read the path from the record, and call `new PipeAddress(path).connect()`.
4. When the connect rejects with `ECONNREFUSED` or `ENOENT`, treat the server as gone.

## The program

The program starts itself as a server and as a client, each in its own process. The client connects while the server listens, after the server crashed, and after the server closed.

```ts title="publish-and-connect.ts"
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { PipeAddress, PipeEndpoint } from '@zukhruf/pipes';

const [role, record] = process.argv.slice(2);

/** Starts this file again as another program, with the same Node options. */
function start(role: string, record: string): ChildProcess {
  return spawn(
    process.execPath,
    [...process.execArgv, import.meta.filename, role, record],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
}

/** Starts a server, and resolves with it when it has published its address. */
async function startServer(record: string): Promise<ChildProcess> {
  const server = start('server', record);
  const lines = createInterface({ input: server.stdout! });
  for await (const line of lines) {
    console.log(`server: ${line}`);
    if (line.startsWith('published')) break;
  }
  return server;
}

/** Runs a client to its end. */
async function runClient(record: string): Promise<void> {
  const client = start('client', record);
  for await (const line of createInterface({ input: client.stdout! })) {
    console.log(`client: ${line}`);
  }
  await once(client, 'exit');
}

if (role === 'server') {
  // A random plain name: no other server listens on this path, ever.
  const endpoint = new PipeEndpoint(randomBytes(16).toHex(), {
    prefix: 'recipe-pipes',
  });
  const server = await endpoint.listen((socket) => {
    socket.end(`hello from process ${process.pid}\n`);
  });
  // Publish the path, so that other programs can connect.
  await writeFile(
    record!,
    JSON.stringify({ address: endpoint.address.path, processId: process.pid }),
  );
  console.log(`published ${endpoint.address.path}`);
  process.once('SIGTERM', () => {
    void server.close();
  });
} else if (role === 'client') {
  const { address } = JSON.parse(await readFile(record!, 'utf8')) as {
    address: string;
  };
  try {
    const socket = await new PipeAddress(address).connect();
    for await (const chunk of socket) process.stdout.write(chunk);
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, 'code') : '';
    // A refused connect, or no file at the path: the server is gone.
    if (code === 'ECONNREFUSED' || code === 'ENOENT') {
      console.log(`the server is gone (${code})`);
    } else throw error;
  }
} else {
  const folder = await mkdtemp(join(tmpdir(), 'recipe-pipes-'));
  const record = join(folder, 'server.json');
  try {
    console.log('1. A server listens, and a client connects.');
    const first = await startServer(record);
    await runClient(record);

    console.log('2. The server crashes. Its socket file stays.');
    first.kill('SIGKILL');
    await once(first, 'exit');
    await runClient(record);

    console.log('3. A new server listens, then closes.');
    const second = await startServer(record);
    await runClient(record);
    second.kill('SIGTERM');
    await once(second, 'exit');
    await runClient(record);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
```

Output on macOS, for the user with the id 501 (the names and the process ids change from run to run):

```
1. A server listens, and a client connects.
server: published /tmp/recipe-pipes-501/bf504b824a054abc7404b5e6260ae611
client: hello from process 94229
2. The server crashes. Its socket file stays.
client: the server is gone (ECONNREFUSED)
3. A new server listens, then closes.
server: published /tmp/recipe-pipes-501/c983ea2277217199aa6ba25c99ca21a8
client: hello from process 94265
client: the server is gone (ENOENT)
```

## Why it works

- **The record holds the path, not the name.** `new PipeAddress(path)` reads no file, makes no file and checks no length: the program that made the path checked it. So the client needs no prefix and no default folder ([ADR 0006](../adr/0006-connect-tries-once.md), [ADR 0007](../adr/0007-the-endpoint-listens-the-address-connects-and-the-server-owns-its-file.md)).
- **A crash leaves a leftover file.** The process that `SIGKILL` ends cannot close its server, so its socket file stays at the path. A connect to it gives `ECONNREFUSED` (step 2).
- **A close removes the file.** `server.close()` stops listening, and Node removes the socket file. A connect to the path then gives `ENOENT` (step 3, [ADR 0003](../adr/0003-listen-removes-the-file-at-the-path-and-close-removes-it-again.md)).
- **A connect tries once.** `address.connect` does not try again, so the client knows at once that the server is gone. What a refused connect means is the caller's rule ([ADR 0006](../adr/0006-connect-tries-once.md)).

## Things to know

- **Give each server a random plain name.** `endpoint.listen` removes the file at the path without a check, so only one server may use a path. sqlite-notify and election take 16 random bytes in hex, and a name is never used again ([ADR 0003](../adr/0003-listen-removes-the-file-at-the-path-and-close-removes-it-again.md)).
- **Remove a leftover file when the client finds one.** The next `endpoint.listen` on a path removes its file, but a random name is never used again. sqlite-notify's sender removes a dead listener's row and its file after a refused connect (`src/wakes.ts`). This program does not: the file of step 2 stays in `/tmp/recipe-pipes-501`.
- **Choose which codes mean "gone".** sqlite-notify takes `ECONNREFUSED` and `ENOENT` (`src/wakes.ts`). election takes `EACCES` too: another user's socket is not its leader (`src/sqlite/leader-reader.ts`). Treat every other error as a failure.
- **Replace the record in one step when a client can read it at any time.** Here the client starts only after the server wrote the record. election writes its leader record with `atomicWrite` of [`@zukhruf/fs`](../../../fs/README.md), so a reader never sees a part of it (`src/sqlite/leader-record.ts`).
- **On Windows, the path is a named pipe.** The server publishes `\\.\pipe\recipe-pipes-<name>`. Windows removes a pipe when its program exits, so a connect after a crash gives `ENOENT`, not `ECONNREFUSED` ([README](../../README.md#what-each-call-does)).
