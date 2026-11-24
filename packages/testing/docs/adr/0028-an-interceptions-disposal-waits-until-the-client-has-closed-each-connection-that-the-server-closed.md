# An interception's disposal waits until the client has closed each connection that the server closed

Status: Accepted 2026-11-24 (Ezz, "Accept"; backlog #5446).

Amended 2026-11-24 (#5485): the disposal waits only for the sockets that `server.close()` destroyed. Before the close, it records each socket that is not destroyed. After the close, it waits for the `close` event of each of those sockets that is now destroyed. The first version waited for each recorded socket that was destroyed, and a real socket of a passthrough is one of them. On a passthrough, `@mswjs/interceptors` 0.45.12 opens a real socket with `net.createConnection` (`lib/node/net-D5G58O2w.js:1078`, `passthrough()`), so the `net.client.socket` channel records it, and `#swapRealHandle` (`:813`) gives its handle to the client socket. The client closes that handle. The real socket then closes a handle that is already closed, and it never emits `close`. The disposal waited for that `close`, and it did not settle: Meddit's Prisma tests on Postgres stopped at their timeout of 300 s with `@zukhruf/testing` 0.8.91. A disposal after a TCP or a TLS exchange that the client closed did not settle in 3 of 3 runs before this change, and it settles now.

On msw 3.0.7 and `@mswjs/interceptors` 0.45.12, `fetch` sends a request through undici, on a socket that the interceptor controls. `server.close()` destroys each idle socket at once, but the socket emits `close` on a later turn. undici clears the timer of the socket in its `close` listener (`onHttpSocketClose`, then `Parser.destroy`, then `clearTimeout`). undici reads the global `setTimeout` and `clearTimeout`, so in a test that fakes them with `t.mock.timers`, the timer came from the fake. With the old synchronous disposal, the test ended and node:test reset its fake timers before that `close`. The `clearTimeout` then ran under the fake timers of the next test, and Node 26.13 removed one of that test's timers. Meddit's PubMed tests found it: a backoff of 1 ms never fired (#5446). A test that fetches once, moves its fake time by 1 s and yields 5 turns, followed by a test that sets a 1 ms timer, yields 5 turns and moves its time by 1 ms, fails 3 of 3 runs with the old disposal and passes with this one.

## Decision

The interception is `AsyncDisposable`, and `cleanup()` returns a promise. The disposal closes the server, and then waits for the `close` event of each client socket that was created while the server listened and that the close destroyed. The interception records the sockets from Node's `net.client.socket` diagnostics channel. It has no `Symbol.dispose`, so `using interception = msw.intercept(...)` does not compile, and each consumer writes `await using`.

## Considered Options

- **Keep `Symbol.dispose` beside `Symbol.asyncDispose`.** A `using` still compiles, and the defect comes back with no sign.
- **Wait a fixed number of turns after `close()`.** Meddit's workaround waits 50 `setImmediate` turns. The number is a guess, and a slower close breaks it again.
- **Close undici's global dispatcher.** Node gives it only through the private `Symbol.for('undici.globalDispatcher.1')`, which [ADR 0010](./0010-the-msw-area-is-always-strict-and-records-each-request.md) does not use.
- **The `undici:client:connected` channel.** It sees only the sockets of `fetch`. `net.client.socket` also sees the sockets of `http.request`.
- **Destroy every recorded socket, also a passthrough socket.** A passthrough request that is still in flight would fail, and the socket belongs to the real server's exchange. The interceptor leaves it open, and so does the disposal.

## Consequences

- Each consumer changes `using` to `await using`, and awaits `cleanup()`. The compiler reports each `using`.
- A passthrough socket still stays open after the disposal, as ADR 0010 says. When the test's `HttpServer` closes it, the same defect appears, because that disposal does not wait for the client's `close` either (#5449).
- A socket that a mocked response with `connection: close` destroyed before the disposal started is not a socket that the close destroyed, so the disposal does not wait for its `close`. When the test disposes the interception in the same turn as that response, the socket can still emit `close` after the disposal.
- A test of another file that runs at the same time, in the same process, can create a socket while the interception listens. The disposal then also waits for that socket when it is destroyed. Its `close` comes a few turns later.
