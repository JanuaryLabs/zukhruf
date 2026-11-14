# Connect tries once

> Changed in part on 2026-11-14 by [ADR 0007](./0007-the-endpoint-listens-the-address-connects-and-the-server-owns-its-file.md): connect is a method of the address, not a function that takes a path. A client that has only a path makes its address with `new PipeAddress(path)`. Connect still tries once and takes no clock.

A client connects to a server. The precedent (research 21 §1, §2):

- .NET's `NamedPipeClientStream` takes a name. It treats `ECONNREFUSED` as "try again", and tries again until its timeout (`NamedPipeClientStream.Unix.cs:52-58`, `NamedPipeClientStream.cs:131-159`). So a client that meets a dead server's file waits out its whole timeout.
- go-winio's `DialPipe` tries again every 10 ms while the pipe is busy, for 2 seconds by default (`pipe.go:228-237`). It takes a path, and `DialPipeContext` takes a context.
- Go's `net.Dial` and Node's `net.connect` try once and give the error. Go's `DialContext` and Node's `signal` stop a connect.

The consumers:

- mutex and single-flight connect once. When nothing listens, they elect, and their poll is their own (`electing-connector.ts`).
- sqlite-notify's sender connects once. A refused connect means the listener died: the sender removes its row and its file (its README, "What each call does"). A retry would only make that slower.
- sqlite-notify's sender reads the path from a row of the listener table, not from a name.

## Decision

- `address.connect({ signal })` calls `net.connect` once, on `address.path`. It resolves with the socket at `connect`. At `error` it destroys the socket and rejects with Node's error.
- A client that read a path from another place makes its address with `new PipeAddress(path)`, which checks nothing and makes nothing.
- `signal` is Node's: an abort destroys the socket, also after the connect.
- The package waits on no timer, so it takes no clock.

## Considered Options

- **Try again until a timeout, as .NET.** It needs a clock, and it makes the dead-listener rule of sqlite-notify wait out the timeout.
- **Take a `PipeEndpoint` made only from a name, as .NET's client takes a name.** sqlite-notify's sender has only the path that it read, and programs need not agree on the default folder. `new PipeAddress(path)` answers this.
- **Connect once.** This option was selected.

## Consequences

- A busy pipe on Windows is libuv's to handle [not read]. Its proof is backlog #4340.
- What `ENOENT` and `ECONNREFUSED` mean is each consumer's rule.
