# @zukhruf/rpc

One end of a program calls methods of another end: a worker thread, a child process, or a process across a socket. This package gives what each such program writes again: a connection that comes back after a loss, calls that wait for their answers by id, a rule for a call that was in flight when the peer went away, and errors that keep their class and their fields across the boundary. Its names come from Go's `net/rpc` (`Client`, `Server`, `ServerError`) and .NET's StreamJsonRpc (`ConnectionLostException`).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/rpc
```

The host starts a worker thread and calls its `greet` method. The thread serves the method on its port.

```ts title="host.ts"
import { Worker } from 'node:worker_threads';

import {
  Client,
  ConnectionSupervisor,
  ErrorCodec,
  type RpcMessage,
  WorkerConnection,
} from '@zukhruf/rpc';

interface Greeter {
  greet(name: string): string;
}

const link = new ConnectionSupervisor<RpcMessage>({
  connect: async () =>
    new WorkerConnection(new Worker(new URL('./greeter.ts', import.meta.url)), {
      tag: '@greeter',
    }),
});
await using client = new Client<Greeter>(link, {
  errors: new ErrorCodec([]),
  answers: { greet: (answer): answer is string => typeof answer === 'string' },
});
console.log(await client.call('greet', ['Ada']));
```

```ts title="greeter.ts"
import { parentPort } from 'node:worker_threads';

import { ErrorCodec, ParentPortConnection, Server } from '@zukhruf/rpc';

const connection = new ParentPortConnection(parentPort!, { tag: '@greeter' });
connection.ref();
new Server(
  { greet: (name: string) => `Hello, ${name}` },
  {
    methods: {
      greet: (params): params is [string] =>
        params.length === 1 && typeof params[0] === 'string',
    },
    errors: new ErrorCodec([]),
  },
).serve(connection);
```

## Call a method of the other end

`client.call(method, params, { signal })` sends a request and waits for its answer. The answer is checked by the client's `answers` check of that method before the call gives it its type: it comes from another thread or process (mutex ADR 0017). A call made while no connection is open goes on the next one. A call that went out on a connection that is lost rejects at once with `ConnectionLostError`, and it is not sent again: the peer may have run it, as a lost Postgres commit may have committed. A call whose `signal` aborts rejects with the signal's reason, and a later answer settles nothing.

`client.notify(method, params)` runs the method on the other end and waits for no answer. A notification made before the connection opens goes once it opens.

## Serve the methods of an object

`server.serve(connection)` answers each request on `connection` with the value of the method, or with the error that it threw. It serves only the methods that `methods` names, each with the check of its parameters: a method of the target with no check is refused, as is a request whose parameters fail the check. Serving does not keep the process alive; the owner of the connection refs it. A notification's method that throws emits a `ServerWarning` (`ZUKHRUF_RPC_NOTIFICATION_FAILED`), because nothing answers a notification.

Each end can run a `Client` and a `Server` on one connection, as StreamJsonRpc's `JsonRpc` does: the client reads the responses and the server reads the requests.

## Keep a connection across a loss

`ConnectionSupervisor` keeps one connection open at a time. It connects on `open`, replaces a connection that is lost, and stops for good when its `Connector` gives `undefined`. It emits `connected`, `message`, `disconnected`, `unavailable` and `failed`. It keeps the last `ref()` or `unref()` for each connection that replaces a lost one.

## Decide what happens to a call that was in flight

`PendingCalls` is the table of the calls that wait for an answer, for a protocol of its own (the mutex's lock requests, the single flight's runs). The owner reports each loss (`interrupt()`) and each new connection (`resume()`), so it can send its own messages first. Each call has a policy for a loss:

| Policy            | What happens                                                                                                                                                | Who uses it                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `'resend'`        | The call goes again on the next connection.                                                                                                                 | The mutex's acquire and look, the single flight's run |
| `{ atLoss }`      | The call leaves the table at the loss, and `atLoss` settles it.                                                                                             | `Client`: `ConnectionLostError`                       |
| `{ atReconnect }` | The call waits, unsent, and `atReconnect` settles it when the next connection opens. A reconnect that fails or cannot come rejects it with the other calls. | The mutex's try: busy                                 |

A call keeps the connection ref'd from its add until it is taken, so the process exits only when no call waits. Give every table on one connection the same `RefCount`.

## Carry errors across

`new ErrorCodec(classes)` encodes a thrown value as `{ name, message, stack, fields, cause }`, and rebuilds it on the other end. `structuredClone` and `v8.serialize` rebuild every error as its native base class and drop own fields such as `code`. The codec rebuilds an error of a listed class, or of a native class (`Error`, `TypeError`, `RangeError` and the others that HTML's structured clone keeps), as an instance of that class with the peer's message, stack, cause and own fields. It does not run the class's constructor. An error of a class that the codec does not list arrives as a `ServerError` with the peer's name, message and fields. A thrown value that is not an error arrives as it is.

## Share a channel with the application

`WorkerConnection`, `ParentPortConnection`, `ChildProcessConnection` and `ProcessChannelConnection` carry each message in the envelope of their `tag`: `{ [tag]: message }`. The application's own messages, and those of another tag, are not read, so they share the channel. The mutex's tag is `'@lock'`.

| Adapter                    | End                              | Tells of a lost peer by                | Keeps the process alive |
| -------------------------- | -------------------------------- | -------------------------------------- | ----------------------- |
| `WorkerConnection`         | The thread that started a worker | `exit`                                 | The worker does         |
| `ParentPortConnection`     | A worker thread                  | never: the thread ends with its parent | While ref'd             |
| `ChildProcessConnection`   | A parent process                 | `disconnect`                           | The child does          |
| `ProcessChannelConnection` | A child process                  | `disconnect`                           | While ref'd             |

## Errors

| Error                   | When                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `ConnectionLostError`   | A call was in flight on a connection that was lost, the client was disposed, or no peer can come again. |
| `ServerError`           | The peer threw an error of a class that this end's codec does not list.                                 |
| `ConnectionClosedError` | A send of an adapter cannot reach the peer, because the connection is closed.                           |
| `TypeError`             | The server has no such method, the parameters fail its check, or the answer fails the client's check.   |
| `RangeError`            | Two classes of an `ErrorCodec` have one name, or `PendingCalls.add` gets an id that waits already.      |

## What the package does not do

- **It does not tell the server that a call was cancelled.** A call whose signal aborts stops only its own wait. A protocol that must stop the work sends its own notification, as JSON-RPC's `$/cancelRequest`.
- **It does not send a lost `Client` call again.** Only the caller knows whether the call may run twice.
- **It does not speak JSON on the wire.** The messages use the member names of JSON-RPC 2.0 and travel as the channel clones them; a socket protocol frames them itself.

## Who uses it

| Consumer                 | How                                                                                                                                                           | Record       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `@zukhruf/mutex`         | The thread and IPC lock stores connect through its adapters with the tag `'@lock'`; `RemoteLockClient` keeps its acquires, tries and looks in `PendingCalls`. | #4984, #2496 |
| `@zukhruf/single-flight` | `FlightClient` keeps its runs in `PendingCalls` over the supervisor.                                                                                          | #4984, #2520 |

## The same concepts in other systems

| Concept                         | Other systems                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Client and server               | Go [`net/rpc`](https://pkg.go.dev/net/rpc) `Client`, `Server`; StreamJsonRpc [`JsonRpc`](https://github.com/microsoft/vs-streamjsonrpc) |
| A lost call                     | StreamJsonRpc `ConnectionLostException`; Go `rpc.ErrShutdown`                                                                           |
| A remote error                  | Go `rpc.ServerError`; StreamJsonRpc `RemoteInvocationException`                                                                         |
| The message shape               | [JSON-RPC 2.0](https://www.jsonrpc.org/specification), sections 4 and 5                                                                 |
| The errors that survive a clone | HTML [structured clone](https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal) of `[[ErrorData]]`     |

comlink 4.4.2, birpc 4.2.0 and vscode-jsonrpc 10.0.2 were probed on Node 26.13.1 (#4984, paper v2): each leaves a call pending after its thread exits, and each loses the `code` of a thrown error.

## API

```ts
export class ConnectionSupervisor<
  Outgoing,
> extends EventEmitter<SupervisorEvents> {
  constructor(connector: Connector<Outgoing>);
  readonly status: SupervisorStatus;
  open(): void;
  send(message: Outgoing): boolean;
  ref(): void;
  unref(): void;
  close(): Promise<void>;
}
export class PendingCalls<Request, Answer> {
  constructor(link: ConnectionSupervisor<Request>, refs: RefCount);
  add(
    id: string,
    request: Request,
    onLost: LostCallPolicy<Answer>,
  ): Promise<Answer>;
  get(id: string): Request | undefined;
  update(id: string, request: Request): void;
  send(id: string): void;
  take(id: string): TakenCall<Request, Answer> | undefined;
  resume(): void;
  interrupt(): void;
  rejectAll(reason: (request: Request) => unknown): void;
}
export class Client<Remote extends Methods<Remote>> implements AsyncDisposable {
  constructor(
    link: ConnectionSupervisor<RpcMessage>,
    options: { errors: ErrorCodec; answers: AnswerChecks<Remote> },
  );
  call<M extends keyof Remote & string>(
    method: M,
    params: Parameters<Remote[M]>,
    options?: { signal?: AbortSignal },
  ): Promise<Awaited<ReturnType<Remote[M]>>>;
  notify<M extends keyof Remote & string>(
    method: M,
    params: Parameters<Remote[M]>,
  ): void;
}
export class Server<Local extends Methods<Local>> {
  constructor(
    target: Local,
    options: { methods: ParamChecks<Local>; errors: ErrorCodec },
  );
  serve(connection: Connection<RpcMessage>): void;
}
export class ErrorCodec {
  constructor(classes: readonly ErrorClass[]);
  encode(reason: unknown): EncodedReason;
  decode(encoded: EncodedReason): unknown;
}
```

## Documentation

- [ADR 0001](./docs/adr/0001-a-lost-call-follows-the-policy-that-its-caller-gives.md): a lost call follows the policy that its caller gives.
- [ADR 0002](./docs/adr/0002-an-error-crosses-as-data-and-is-rebuilt-from-a-list-of-classes-without-its-constructor.md): an error crosses as data and is rebuilt from a list of classes, without its constructor.
- [ADR 0003](./docs/adr/0003-each-end-checks-what-it-receives.md): each end checks what it receives.
- [Copied code](./docs/copied-code.md)
