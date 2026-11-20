# @zukhruf/pipes

Design for review: no code yet.

Open:

- The per-user rule on Windows. `node:net` cannot set the security of a named pipe, and cannot read the owner of a pipe that it connects to. .NET does both for `PipeOptions.CurrentUserOnly`. By the Windows docs, the default security of a pipe gives every user read access [inference, not run]. Its proof is backlog #4340, and nothing waits for it.
- A rooted name that only this user may use. A name that is not rooted goes into a folder of this user ([ADR 0002](./docs/adr/0002-the-default-folder-belongs-to-one-user.md)). A rooted name goes into the caller's folder, and this package does not check that folder. No consumer needs the check today. tmux's checks on the caller's folder could be the rule when one does.

One program of a computer listens, and other programs of the same computer connect to it. `node:net` does this with a Unix domain socket on macOS and Linux, and with a named pipe on Windows. Each program that does it must answer the same questions. Where is the socket file? Is its path short enough? What if a crashed server left its file? Can another user connect? Which name does the pipe get on Windows? This package answers them once. Its model is .NET's `System.IO.Pipes`: one name gives a pipe on Windows and a socket file elsewhere. libuv calls both kinds a pipe too (`uv_pipe_t`).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md). The research named here is in the pool map, `.scratch/one-pool-for-the-computer/` at the workspace root, which git does not track.

## Use it

This project is an experiment. It uses only `node:net`, `node:fs` and `node:crypto`.

```sh
npm install @zukhruf/pipes
```

```ts
import { PipeEndpoint } from '@zukhruf/pipes';

const endpoint = new PipeEndpoint('greeter', { prefix: 'example' });

await using server = await endpoint.listen((socket) => {
  socket.end('hello\n');
});

const socket = await endpoint.address.connect();
for await (const chunk of socket) console.log(String(chunk).trim());
console.log(server.endpoint.address.path);
```

Output on macOS and Linux, for the user with the id 501:

```
hello
/tmp/example-501/greeter
```

Output on Windows:

```
hello
\\.\pipe\example-greeter
```

## The API

```ts
import type { Socket } from 'node:net';

/** An endpoint that this program owns: it may listen on it. Made from a name (a rooted name is the full path; any other name goes into /tmp/<prefix>-<uid>). */
export class PipeEndpoint {
  constructor(name: string, options: PipeEndpointOptions);
  /** Where other programs connect; publish `address.path` for them. */
  readonly address: PipeAddress;
  /** Removes the file at the path (ADR 0003), listens, and resolves when listening. */
  listen(connectionListener: (socket: Socket) => void): Promise<PipeServer>;
}

/** Where to connect: the path of a pipe on this system, as a program published it. Go's net.UnixAddr. */
export class PipeAddress {
  constructor(path: string); // checks nothing and makes nothing
  /** The path that `node:net` connects to: a socket path on macOS and Linux, a pipe path on Windows. */
  readonly path: string;
  /** Tries once (ADR 0006). Resolves when the socket is connected. */
  connect(options?: { signal?: AbortSignal }): Promise<Socket>;
}

export interface PipeEndpointOptions {
  /** Names the default folder, `/tmp/<prefix>-<uid>`, and starts each pipe name on Windows. */
  prefix: string;
}

/** The owner of the socket file while it listens on the path of one endpoint. */
export class PipeServer implements AsyncDisposable {
  readonly endpoint: PipeEndpoint;
  /** Lets the program exit while the server listens, as net.Server#unref. */
  unref(): this;
  /** Stops listening; Node removes the socket file at the path. Resolves when closed. Connections that are open stay open (Node's rule); the caller ends them. A call after the first closes nothing more, as .NET's Dispose ignores the calls after the first: it waits for the same close and resolves. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export class UnsafeFolderError extends Error {
  /** The default folder. */
  readonly path: string;
}
```

## The rules

- A name is rooted or plain. A rooted name is an absolute path (`path.isAbsolute`). A plain name is one file name: not empty, not `.` or `..`, with no `/`, no `\`, and no zero byte. This is .NET's rule: "Caller is in full control of file location" for a rooted name, and the default folder for any other name ([ADR 0001](./docs/adr/0001-the-scope-and-the-name-of-dotnet-system-io-pipes.md)).
- On macOS and Linux, a rooted name is the socket path as it is. A plain name is the file `<name>` in the default folder, `/tmp/<prefix>-<uid>`. `<uid>` is `process.getuid()`.
- On Windows, a plain name is the pipe `\\.\pipe\<prefix>-<name>`. A rooted name is the pipe `\\.\pipe\<prefix>-<id>`, where `<id>` is the first 32 hex digits of the SHA-256 of the resolved path in lower case. Pipe names are one namespace for the computer, and Windows paths ignore case, so two programs that give the same path meet at one pipe ([ADR 0005](./docs/adr/0005-a-rooted-name-on-windows-is-a-pipe-named-by-a-hash-of-its-path.md)).
- `prefix` follows the rule of a plain name. It takes the place of .NET's fixed prefix `CoreFxPipe_`: each consumer gives its own, so two consumers never share a folder or a pipe.
- An endpoint is a value that this program owns: it holds its address and nothing else. An address is a value too: it holds a path. Two addresses with one path are one pipe. The endpoint listens, the address connects, and the server owns the socket file. A program cannot listen on another program's path, because an address has no `listen` ([ADR 0007](./docs/adr/0007-the-endpoint-listens-the-address-connects-and-the-server-owns-its-file.md)).
- `new PipeEndpoint` reads no file and makes no file. It throws a `RangeError` when the socket path is too long: more than 103 bytes on macOS and 107 bytes on Linux, in UTF-8, of the path as it is given. These are .NET's and Go's limits: one byte less than `sun_path` ([ADR 0004](./docs/adr/0004-the-socket-path-is-at-most-one-byte-less-than-sun-path.md)).
- `new PipeAddress(path)` takes a path that a program made and published, for example in a row of a table. It reads no file, makes no file and checks no length: the program that made the path checked it. Programs need not agree on the default folder.
- `endpoint.listen` with a plain name makes the default folder with mode `0700` when it is missing. Then it reads the folder with `lstat`. It throws `UnsafeFolderError` when the folder is not a folder (a link is not a folder), when its owner is another user, or when its group or others have any access. These are tmux's checks for `/tmp/tmux-<uid>`, and the group too ([ADR 0002](./docs/adr/0002-the-default-folder-belongs-to-one-user.md)).
- `endpoint.listen` with a rooted name does not make the folder. The caller's folder must exist.
- On macOS and Linux, `endpoint.listen` removes the file at the socket path before it listens, without a check, as .NET's pipe server, Docker and containerd do. So give a path that only one server listens on at a time: an election proves it for `@zukhruf/mutex` and `@zukhruf/single-flight`, and a random name for `@zukhruf/sqlite-notify` ([ADR 0003](./docs/adr/0003-listen-removes-the-file-at-the-path-and-close-removes-it-again.md)).
- The server owns the socket file while it listens. `server.close()` stops listening at once, and Node removes the socket file. Node removes the file at the path, also when another server's file is there now (probe, 2026-11-14). So a server that lost its right to the path closes before the next server listens. `await using` closes it too: `[Symbol.asyncDispose]` is `close`.
- Only the first `server.close()` or `[Symbol.asyncDispose]()` closes. A later call, also one made while the first waits for open connections, waits until the server has closed and resolves. Node calls the callback of `close` at the `close` event, and passes `ERR_SERVER_NOT_RUNNING` only "if the server was not open when it was closed" (Node's docs), so the package takes that code as the close that came first. Node never fails the close of a server that listens. This is .NET's rule for `IDisposable.Dispose`: "If an object's Dispose method is called more than once, the object must ignore all calls after the first one" ([learn.microsoft.com](https://learn.microsoft.com/en-us/dotnet/api/system.idisposable.dispose)). Node's `net.Server[Symbol.asyncDispose]` resolves on a second call too, but its `close` rejects with `ERR_SERVER_NOT_RUNNING`. Mutex closes its lock server twice: a lost term closes it, and the store's dispose closes it again.
- `server.close()` does not end the connections that are open. This is Node's rule. The caller keeps them and ends them: mutex destroys them, and single-flight ends each one after what it wrote is sent. Close first, and end them in the same step, so no new connection comes in between.
- A crash leaves the socket file. A connect to it gives `ECONNREFUSED` (research 20a P1). The next `endpoint.listen` on the path removes it. Windows removes a pipe when its program exits.
- A socket that Node makes has mode `0755`. Another user cannot connect to it, because a connect needs the write bit (research 20a P5, Linux).
- `address.connect` connects once. It does not try again, and it does not remove a dead server's file: what a refused connect means is the caller's rule ([ADR 0006](./docs/adr/0006-connect-tries-once.md)).
- The package waits on no timer, so it takes no clock.
- The socket is the `net.Socket` of `node:net`. Call `socket.unref()` when it must not keep the program alive, and `server.unref()` for the server.

## Errors

| Error                | When                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RangeError`         | `new PipeEndpoint` makes a socket path longer than the limit. The message: `The socket path <path> is <n> bytes, more than <limit>; choose a shorter folder or name.` .NET throws `ArgumentOutOfRangeException` here.                                                                                                                       |
| `TypeError`          | A plain name or a prefix that breaks the rule of a plain name. The message names the value and the rule.                                                                                                                                                                                                                                    |
| `UnsafeFolderError`  | `endpoint.listen` with a plain name finds a default folder that is not a folder, is a link, belongs to another user, or gives access to its group or others. `path` is the folder. The message is tmux's: `<path> is not a folder` or `<path> has unsafe permissions`.                                                                      |
| The error of Node.js | All other failures, with its `code`. `endpoint.listen`: `EADDRINUSE` when a live pipe has the name on Windows, `EACCES` for a folder that this user cannot write. `address.connect`: `ENOENT` when nothing is at the path, `ECONNREFUSED` for a dead server's file, `EACCES` for another user's socket, `ABORT_ERR` when the signal aborts. |

Check a code with `isErrno` of [`@zukhruf/fs`](../fs/README.md#check-the-error-code). A failed `endpoint.listen` closes its `net.Server`, and a failed `address.connect` destroys its socket.

## What each call does

| Call                                          | macOS and Linux                                                                                                   | Windows                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `new PipeEndpoint(plain name)`                | The path `/tmp/<prefix>-<uid>/<name>`. Checks its length.                                                         | The path `\\.\pipe\<prefix>-<name>`.                                                      |
| `new PipeEndpoint(rooted name)`               | The name is the path. Checks its length.                                                                          | The path `\\.\pipe\<prefix>-<32 hex digits of the hash of the lowercased resolved path>`. |
| `new PipeAddress(path)`                       | The path as it is. Checks nothing.                                                                                | The path as it is. Checks nothing.                                                        |
| `endpoint.listen`, plain name                 | Makes the default folder with mode `0700` if it is missing, and checks it. Removes the file at the path. Listens. | Listens.                                                                                  |
| `endpoint.listen`, rooted name                | Removes the file at the path. Listens.                                                                            | Listens.                                                                                  |
| `server.close()`, or the end of `await using` | Stops listening. Node removes the file at the path. Open connections stay open.                                   | Windows removes the pipe. Open connections stay open.                                     |
| The server's program crashes                  | The file stays. A connect gives `ECONNREFUSED`.                                                                   | Windows removes the pipe. A connect gives `ENOENT`.                                       |
| `address.connect()`, nothing listens          | `ENOENT` when there is no file, `ECONNREFUSED` when a dead server's file is there.                                | `ENOENT`.                                                                                 |
| Another user's program connects               | `EACCES`: the socket has mode `0755`, and the default folder has mode `0700` (research 20a P5).                   | The default security of a pipe gives every user read access [inference, not run; #4340].  |

## Who uses it

| Consumer                 | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Record        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `@zukhruf/mutex`         | `new PipeEndpoint(resolve(directory, 'lock.sock'), { prefix: 'zukhruf-mutex' })`. The lock server calls `endpoint.listen` when its election wins, and each client calls `endpoint.address.connect`. It replaces `socketPathFor` in `src/lock-stores/socket/socket-store.ts`, the `rm`, `createServer`, `listen` and `once(server, 'listening')` in `lock-server.ts`, and `connect` and `once(socket, 'connect')` in `reach` of `electing-connector.ts`. The lock server keeps its set of connections, and holds a `PipeServer` in place of a `net.Server`. | backlog #2496 |
| `@zukhruf/single-flight` | The same with `flight.sock` and the prefix `zukhruf-single-flight`. It replaces `src/connection/socket-path.ts`, the same lines in `src/coordinator/flight-server.ts`, and `reach` in `src/connection/electing-connector.ts`. The ledger `docs/copied-from-mutex.md` records it.                                                                                                                                                                                                                                                                           | backlog #2496 |
| `@zukhruf/sqlite-notify` | `new PipeEndpoint(<listener id>, { prefix: 'zukhruf-sqlite-notify' })`. The listener id is 16 random bytes in hex. The listener calls `endpoint.listen` and writes `endpoint.address.path` in its row. A sender calls `new PipeAddress(<the path it read>).connect()`, and removes a dead listener's file after a refused connect.                                                                                                                                                                                                                         | its ADR 0008  |

Backlog #2496 holds the transport code that mutex and single-flight copy. This package is its socket-address part: the third consumer, `@zukhruf/sqlite-notify`, needs only that part. JSON lines, the handshake, the connection supervisor and the server shell keep their two copies.

### Mutex's code before and after

The socket store names the pipe. Before (`socketPathFor` in `socket-store.ts`):

```ts
if (process.platform === 'win32') {
  const id = hash('sha256', resolve(directory).toLowerCase()).slice(0, 32);
  return `\\\\.\\pipe\\mutex-${id}`;
}
const socketPath = join(directory, 'lock.sock');
if (Buffer.byteLength(socketPath) > SOCKET_PATH_LIMIT)
  throw new RangeError(/* ... */);
return socketPath;
```

After:

```ts
const endpoint = new PipeEndpoint(resolve(directory, 'lock.sock'), {
  prefix: 'zukhruf-mutex',
});
```

The pipe on Windows becomes `\\.\pipe\zukhruf-mutex-<id>`, with `<id>` from the path of `lock.sock`: pipe names are one namespace for the computer, so the prefix names the package.

The lock server starts. Before (`lock-server.ts`):

```ts
if (process.platform !== 'win32') {
  await rm(socketPath, { force: true });
}
const server = createServer(onConnection);
server.listen(socketPath);
await once(server, 'listening');
server.unref();
```

After:

```ts
const server = (await endpoint.listen(onConnection)).unref();
```

The lock server closes. The order stays: stop listening, drop the connections, wait for the close, then end the term.

```ts
const closed = this.#server.close();
for (const socket of this.#connections) socket.destroy();
await closed;
await this.#term.resign({ clean });
```

A client reaches the leader. Before (`reach` in `electing-connector.ts`):

```ts
async function reach(socketPath: string): Promise<Socket | undefined> {
  const socket = connect(socketPath);
  try {
    await once(socket, 'connect');
    return socket;
  } catch {
    socket.destroy();
    return undefined;
  }
}
```

After:

```ts
async function reach(endpoint: PipeEndpoint): Promise<Socket | undefined> {
  return endpoint.address.connect().catch(() => undefined);
}
```

## The same concepts in other systems

| System                                                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| .NET `System.IO.Pipes`: `NamedPipeServerStream`, `NamedPipeClientStream`    | The model of this package, with its classes: a server and a client, each `IDisposable`. One name gives `\\.\pipe\<name>` on Windows and `$TMPDIR/CoreFxPipe_<name>` elsewhere; a rooted name is the full path. The server removes a leftover file before it binds, and removes the file at the last dispose. `PipeOptions.CurrentUserOnly` checks the peer's user id on Unix and sets an ACL on Windows (research 21 §1). |
| .NET `UnixDomainSocketEndPoint`                                             | Counts the path in UTF-8 bytes with its ending zero byte, and throws `ArgumentOutOfRangeException` above `sun_path`: 103 bytes on macOS, 107 on Linux. A value object for an address. `PipeEndpoint` takes its name, its check and its role.                                                                                                                                                                              |
| Go `net`                                                                    | `net.Listen("unix", path)` and `net.Dial("unix", path)`. The same byte limits. A listener removes its file at `Close` by default (`SetUnlinkOnClose`). A leftover file makes the bind fail. No named pipes.                                                                                                                                                                                                               |
| [go-winio](https://github.com/microsoft/go-winio)                           | `ListenPipe` and `DialPipe` for Windows named pipes: two factory functions, each giving a `net.Listener` or a `net.Conn`. The caller gives the full `\\.\pipe\` path and the security in SDDL.                                                                                                                                                                                                                            |
| Docker [`go-connections/sockets`](https://github.com/docker/go-connections) | Removes the file at the path before it listens, without a check, and sets the mode and owner of the socket. Joins `"unix"` and `"npipe"` for HTTP transports. The caller gives the full path.                                                                                                                                                                                                                             |
| [libuv](https://github.com/libuv/libuv) `uv_pipe_t`                         | The handle under `node:net` for both kinds: a Unix socket on macOS and Linux, a named pipe on Windows. Node's docs call both "IPC" and give the same byte limits (`doc/api/net.md`).                                                                                                                                                                                                                                      |
| tmux                                                                        | Makes `/tmp/tmux-<uid>` with mode `0700`, and refuses it when it is not a folder, when its owner is another user, or when others have access (`tmux.c:209-229`, tag 3.5a). The default folder has the same checks.                                                                                                                                                                                                        |

## Documentation

**Recipes**

- [Publish a pipe's address and connect to it from another program](./docs/recipes/publish-an-address-and-connect-from-another-program.md)

**Decisions**

- [0001 The scope and the name of .NET's System.IO.Pipes](./docs/adr/0001-the-scope-and-the-name-of-dotnet-system-io-pipes.md)
- [0002 The default folder belongs to one user](./docs/adr/0002-the-default-folder-belongs-to-one-user.md)
- [0003 Listen removes the file at the path, and close removes it again](./docs/adr/0003-listen-removes-the-file-at-the-path-and-close-removes-it-again.md)
- [0004 The socket path is at most one byte less than sun_path](./docs/adr/0004-the-socket-path-is-at-most-one-byte-less-than-sun-path.md)
- [0005 A rooted name on Windows is a pipe named by a hash of its path](./docs/adr/0005-a-rooted-name-on-windows-is-a-pipe-named-by-a-hash-of-its-path.md)
- [0006 Connect tries once](./docs/adr/0006-connect-tries-once.md)
- [0007 The endpoint listens, the address connects, and the server owns its file](./docs/adr/0007-the-endpoint-listens-the-address-connects-and-the-server-owns-its-file.md)
