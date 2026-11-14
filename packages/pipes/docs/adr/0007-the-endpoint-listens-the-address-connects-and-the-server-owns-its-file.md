# The endpoint listens, the address connects, and the server owns its file

The first paper (commit abfa1508) gave two lone functions: `listenPipe(endpoint, listener)` and `connectPipe(path, options)`. They took their names from go-winio's `ListenPipe` and `DialPipe`, and their style from Go's `net.Listen` and Node's `net.createServer`. Ezz objected on 2026-11-14: no lone functions here.

The reason is in the domain. A server that listens owns a resource for a lifetime: the socket file. That resource has a rule. The close removes the file. Node removes the file at the path, also when another server's file is there now ([ADR 0003](./0003-listen-removes-the-file-at-the-path-and-close-removes-it-again.md)). So a server that lost its right to the path must close before a new owner listens. A lone function gives a `net.Server`, and each consumer then keeps that rule for itself.

The precedent:

- .NET's `System.IO.Pipes`, the model of this package, has classes: `NamedPipeServerStream` and `NamedPipeClientStream`. Both are `IDisposable`. The server removes the file at its last dispose (research 21 §1).
- This is the Dispose pattern of .NET (`IDisposable`), and RAII in C++: the owner of a resource is an object, and its disposal releases the resource. JavaScript has it as `Symbol.asyncDispose` and `await using`.
- .NET's `UnixDomainSocketEndPoint` is a value object for an address. It holds the path and checks its length.
- Go's `net.Listen` and `net.Dial`, go-winio's `ListenPipe` and `DialPipe`, and Node's `net.createServer` and `net.connect` are factory functions. They give the object of the platform and add no owner.

The consumers: mutex's lock server and single-flight's flight server each remove the file, make a `net.Server`, listen, wait for `listening`, call `unref`, keep a set of connections, and at the end of a term close the server and end the connections (`lock-server.ts`, `flight-server.ts`). Each client's `reach` connects once and waits for `connect` (`electing-connector.ts`). sqlite-notify's sender connects to a path that it read from the listener table.

## Decision

Ezz chose the shape on 2026-11-14.

- The owned endpoint and the published address are two types, so a listen on another program's path cannot be written. This is Ezz's rule, "make illegal states unrepresentable"; .NET keeps the server and the client in two classes, and Go has `net.UnixAddr` for an address.
- `PipeEndpoint` is the endpoint that this program owns. It is made from a name (`new PipeEndpoint(name, { prefix })`) and holds its `address`. It listens: `endpoint.listen(connectionListener)`.
- `PipeAddress` is where to connect: a path that a program published. `new PipeAddress(path)` checks nothing and makes nothing. It connects: `address.connect({ signal })`. A program that connects to its own endpoint writes `endpoint.address.connect()`.
- `endpoint.listen` gives a `PipeServer`. It owns the socket file while it listens. Its `close()` and its `[Symbol.asyncDispose]()` stop listening, and Node removes the file. It has `unref()` and `endpoint`, and nothing else.
- `connect` gives the `net.Socket` of `node:net`. A socket owns no file, so it needs no class of this package.
- `PipeServer` does not end the connections that are open, as Node's server does not. The caller keeps them, because mutex destroys them and single-flight ends each one after what it wrote is sent.

## Considered Options

- **Factory functions, as Go and Node.** `listenPipe` gives a `net.Server`. The rule of the file's lifetime then lives in each consumer: which object to close, and that a lost server closes before the next listen. That is the knowledge this package exists to hold once.
- **A `PipeServer` that also ends the connections.** mutex and single-flight end them in two different ways, and Node does not do it. One of them would need an option.
- **A `PipeServer` that gives its `net.Server`.** No consumer calls anything on the server but `listen`, `unref` and its dispose. A `net.Server` given out could be closed or listened on again past the owner.
- **One endpoint class that listens and connects, with `PipeEndpoint.fromPath(path)` for a published path.** An endpoint from a published path could then listen, and its listen would remove the file of the program that published it.
- **The endpoint listens, the address connects, and the server owns its file.** This option was selected.

## Consequences

- The names `listenPipe` and `connectPipe` are gone. go-winio stays in the README's list of other systems, but gives no names.
- A consumer holds a `PipeServer` in place of a `net.Server`, and its `await using` or its `close` releases the file. The order of mutex and single-flight stays: close, end the connections, wait for the close, then end the term.
- [ADR 0006](./0006-connect-tries-once.md) keeps its decision: connect tries once and takes no clock. Its "takes a path" becomes `new PipeAddress(path)`.
- Only the first `close()` or `[Symbol.asyncDispose]()` of a `PipeServer` closes; each later call waits for that close and resolves. Node's `close` callback passes `ERR_SERVER_NOT_RUNNING` at the `close` event when an earlier call closed the server, and the package takes that code as success; it keeps no promise in a field (`zukhruf/no-promise-field`). .NET's `IDisposable.Dispose` must ignore all calls after the first, and Node's `net.Server[Symbol.asyncDispose]` resolves on a second call. Mutex closes its lock server twice: a lost term closes it, and the store's dispose closes it again.
