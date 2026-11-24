# no-unhandled-readline-error counts an input that the code can write to

Status: Accepted on 2026-11-24 (#5458). Ezz chose "Accept the narrowing": only an input that the code can write to (a socket, a TLS socket, a PassThrough, any Duplex) counts, and a child process's stdout, a plain Readable and process.stdin do not.

readline emits the errors of its input again on its interface. With no `'error'` listener on the interface, the error is an uncaught exception, even when the input has its own listener. A coordinator that a test served read its peers with readline, and Linux CI turned red twice: in #2573 (single-flight, fixed in 5e83b4e) and in #5265 (mutex, red from 368c4f9c, fixed in 6be94b21). Linux resets a Unix socket when its peer closes with data in its receive queue that it did not read. macOS does not, so every local run passed.

`zukhruf/no-unhandled-readline-error` reports a readline interface that nothing listens on for `'error'`, when its input is a stream that the code can write to: a type with `read`, `write` and `on`, which is a `net.Socket`, a TLS socket, a `PassThrough` or another `Duplex`. A `tty.ReadStream` is left out (the rule knows it by `setRawMode`), so `process.stdin` is not reported. A function counts as a listener when its own body listens on the parameter that it is given, as `leaveErrorsToClose` of `@zukhruf/mutex` does. The rule reads that body through the type checker.

## Considered Options

- **Every input typed as a stream.** A `Readable` can emit `'error'` by the stream contract, so this option reported the stdout and stderr of child processes too. On the real code it reported 12 sites: 8 in zukhruf and 4 in context-compiler, and every one reads a child's `stdout` or `stderr`. A judge that did not write the rule found all 12 to be false. libuv makes a child's `'pipe'` stdio as a socketpair, but the parent never writes into the child's stdout, so the child's end has nothing unread when it closes. A probe on node:26-alpine killed a child while readline read its stdout: 0 of 20 runs gave an error. A control run where the parent also wrote into that stdout gave ECONNRESET in 20 of 20 runs. With 12 of 12 hits on good code, this option is not exact.
- **Report only an input that the code also writes to, found by data flow.** This follows the cause most closely, but the rule must then find every write through aliases, fields and helpers. The type of the input says the same thing for the code in these repos.
- **A stream that the code can write to, by its type.** This option was selected. On the old code of the two breaks, it reported each of the 14 sites that the two fixes changed: 4 in single-flight at 5e83b4e^ and 10 in mutex at 6be94b21^, among them socket-store.test.ts:939 as 368c4f9c added it. On the fixed code, and on all of zukhruf, elt and context-compiler today, it reported nothing.
- **An option that names the helpers that listen.** Each repo would fill the list with its own names. The package does not take such a rule key (CONTEXT.md, "Repo-owned rule"; [ADR 0001](./0001-one-key-per-check.md)). The body of the helper already tells the rule what it does.

## Consequences

- An interface over a child's stdout, a file stream or a `Readable` parameter is not reported, also when the stream does fail, for example with ENOENT. Such a failure happens on macOS too, so a local run shows it.
- A helper that takes its input as a `Readable` and makes the interface itself is not checked inside, because its input is not a Duplex by type, and a caller that gives it a socket is not checked either. Thus a helper names the type that it reads: mutex's `linesOf` takes a `Socket`, so the rule checks its body.
- A function that only a `.d.ts` declares has no body to read, so passing the interface to it does not count. A consumer listens for `'error'` where it makes the interface, or reads it with `for await`.
- `once(lines, 'line')` of `node:events` does not count: its listener goes away when the line comes, and the next error is uncaught.
- Code inside a template string, such as the program of a child process that a test writes, is not linted.
