# Recipe: Stop an HTTP server at a termination signal

**Use case.** A program serves HTTP until a supervisor stops it. At the termination signal, the server must stop new connections, the cleanup must run, and the process must die by the signal. The package does not stop the server: the program waits for the signal, and then the end of the `await using` scope closes the server. A wait that never ends keeps the process alive until a second Ctrl-C. This happened in the websets app of context-compiler (#3929).

**What you need.** A `Shutdown`, and a `node:http` server.

## The steps

1. Make one `Shutdown` at the start of the entry point, before the first `await`.
2. Start the server in an `await using` scope after the `Shutdown`. Then the server closes before the scope of the `Shutdown` ends.
3. Wait on the signal itself: `if (!shutdown.signal.aborted) await once(shutdown.signal, 'abort')`.
4. Let the scope end. The server closes, and then the process dies by the termination signal.

## The program

The program runs twice. As the supervisor, it starts itself as the server, sends one request, and then sends SIGINT to the server. As the server, it answers the request and waits for the signal.

```ts title="stop-a-server.ts"
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';

import { Shutdown } from '@zukhruf/shutdown';

if (process.argv[2] === 'server') {
  // The server: make the Shutdown first, so that a termination signal during
  // the start also stops the program.
  using shutdown = new Shutdown();
  await using server = createServer((request, response) => {
    response.end('hello\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  console.log(`listening on ${(server.address() as AddressInfo).port}`);

  // Wait on the signal itself. once() does not settle for a signal that
  // aborted before the call, so check it first.
  if (!shutdown.signal.aborted) {
    await once(shutdown.signal, 'abort');
  }
  console.log(`stopping: ${(shutdown.signal.reason as Error).message}`);
  server.once('close', () => console.log('server closed'));
} else {
  // The supervisor: start the server, send it a request, then SIGINT.
  const child = spawn(
    process.execPath,
    [...process.execArgv, import.meta.filename, 'server'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => console.log(`server: ${line}`));
  const [first] = (await once(lines, 'line')) as [string];
  const port = first.split(' ').at(-1);

  const response = await fetch(`http://127.0.0.1:${port}/`);
  console.log(`response: ${response.status} ${(await response.text()).trim()}`);

  child.kill('SIGINT');
  const [code, signal] = await exited;
  console.log(`exit status: code ${code}, signal ${signal}`);
}
```

Output on Node.js 26.13.0 (the port changes from run to run):

```
server: listening on 59851
response: 200 hello
server: stopping: The process received SIGINT
server: server closed
exit status: code null, signal SIGINT
```

## Why it works

- At SIGINT, the signal aborts with the cause `The process received SIGINT`, and the wait ends.
- The scopes end in reverse order. `server[Symbol.asyncDispose]()` closes the server first, and then the scope of the `Shutdown` ends.
- The event loop has no more work, and Node.js emits `'exit'`. The package re-raises SIGINT, so the supervisor gets `signal SIGINT` and no exit code ([ADR 0001](../adr/0001-the-process-dies-by-its-termination-signal-after-the-cleanup.md)).

## Things to know

- **Do not wait with `util.aborted(shutdown.signal, resource)` on a resource that nothing else holds.** `util.aborted()` holds its resource weakly. When a garbage collection takes the resource before the signal aborts, the promise never settles ([Node.js docs](https://nodejs.org/api/util.html#utilabortedsignal-resource)). In #3929, websets waited with `util.aborted(ends, collections)`, the wait never ended after a garbage collection took the array, and the queue's timers kept the process alive. The fix waits on the signal itself (context-compiler commit `2d8c016`).
- **`once(signal, 'abort')` needs the check of `signal.aborted`.** A signal that aborted before the call emits no `'abort'` event again, so `once()` alone waits forever. See [Stop an HTTP server](../../README.md#stop-an-http-server).
- **`close()` waits for the open requests.** Node.js keeps a connection that becomes idle after the call to `close()` until `keepAliveTimeout`, and a request that does not answer until `requestTimeout`. Call `server.closeAllConnections()` after a short time to end them. The README gives the measured times.
- **A second termination signal ends the process at once.** Use it when the cleanup does not end ([ADR 0002](../adr/0002-only-the-first-stop-request-starts-a-shutdown.md)).
- **In a container without an init process, the server exits with code 143 for SIGTERM.** See [Run in a container](../../README.md#run-in-a-container).
