# RPC

One end of a program calls methods of another end: a worker thread, a child process, or a process across a socket. This package carries the calls, keeps the connection across a loss, and carries the errors.

## Language

**Connection**:
A message channel to one peer, through an adapter of a worker, a port, an IPC channel or a socket. It reports each message and, once, that the peer is gone.
_Avoid_: Channel (the Node object that an adapter wraps), link, socket

**Connector**:
What makes a connection for a supervisor: at each `connect`, a new connection, `undefined` when no peer can come again, or a rejection when this attempt failed.
_Avoid_: Dialer, factory

**Supervisor**:
A `ConnectionSupervisor`: it keeps one connection open at a time and replaces a lost one.
_Avoid_: Reconnector, link (the field name that holds it)

**Hold**:
A token of `link.hold()`: while one is out, the supervisor keeps the process alive through its connection. A server holds its link while it serves, and a call while it waits (ADR 0004).
_Avoid_: Ref (the switch of one connection), keep-alive, lease

**Tag**:
The key of the envelope that each message of a shared channel travels in: `{ [tag]: message }`. The mutex's tag is `'@lock'`.
_Avoid_: Namespace, prefix, channel name

**Call**:
A request that waits for its answer, by id. JSON-RPC 2.0's request.
_Avoid_: Request (the message of a call), invocation

**Notification**:
A request with no id: nothing answers it. JSON-RPC 2.0's word.
_Avoid_: Event, message, fire-and-forget call

**Lost call**:
A call that went out on a connection that was lost before its answer came. Its policy decides what happens to it: `'resend'`, `atLoss` or `atReconnect`.
_Avoid_: Stranded call, dropped call, orphan

**Check**:
A function that a client gives for the answer of each method, and a server for the parameters of each method it serves. What arrives from another thread or process is checked before it gets its type.
_Avoid_: Validator, schema, guard

**Codec**:
An `ErrorCodec`: it turns a thrown value into data that crosses, and back, as an instance of a listed or native class, or as a `DOMException`.
_Avoid_: Serializer, transformer
