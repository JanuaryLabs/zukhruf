# An HTTP server's disposal waits until a client of the process has closed each connection that the server closed

Status: Accepted 2026-11-24 (backlog #5449).

Decision-makers: the zukhruf session mutex-07, which decided from the evidence.

`HttpServer`'s disposal closes the server and each of its connections. It resolved when the server closed. On Node 26.13, `fetch` keeps the connection open after the response. When the server destroys its side, the client socket emits `close` some turns later. undici clears the timer of the socket in its `close` listener, with the global `clearTimeout` ([ADR 0028](./0028-an-interceptions-disposal-waits-until-the-client-has-closed-each-connection-that-the-server-closed.md) has the path). Thus in a test that fakes the timers with `t.mock.timers`, that `clearTimeout` ran under the fake timers of the next test, and Node removed one of that test's timers. A test that starts a server, fakes `setTimeout`, fetches once, moves its time by 1 s and yields 5 turns, followed by a test that sets a 1 ms timer, yields 5 turns and moves its time by 1 ms: the timer did not fire in 3 of 3 runs. With an msw passthrough for the origin of the server in front, the same test failed in 3 of 3 runs.

On a passthrough, each connection has two client sockets in the process, measured with `@mswjs/interceptors` 0.45.12 and two keep-alive connections. One is the socket of `fetch`, which the interceptor controls. The other is the real socket that the interceptor opens (`lib/node/net-D5G58O2w.js:1078`, `passthrough()`) and whose handle it gives to the first one (`#swapRealHandle`, `:813`). Before the close, both have the local port of the connection. After the close, the socket of `fetch` emits `close`. The real socket emits `end` and becomes destroyed, but it never emits `close`. A disposal that waits for the `close` of each socket of a connection never settles, as in #5485.

A client of `http.request` with an `http.Agent({ keepAlive: true })` did not lose a timer before this change, in 3 of 3 runs. Node's HTTP client does not use the global timers.

## Decision

The disposal waits, for each connection that the close destroyed, until the first client socket of the process that belongs to that connection emits `close`. While the server listens, the server records each connection that it accepts, and records each client socket of the process from Node's `net.client.socket` diagnostics channel. Before the close, the disposal pairs each open connection with the client sockets that are not destroyed and whose remote address and port are the server's, and whose local port is the remote port of the connection. A connection with no client socket in the process, such as a client in a child process, gets no wait.

## Considered Options

- **Wait for the `close` of each paired client socket.** The real socket of a passthrough never emits `close`, so the disposal does not settle.
- **Wait for the `close` of each client socket that the close destroyed, as the msw disposal does.** The close destroys only the server's side. Each client socket is still open when the server has closed, so the disposal waits for none.
- **Destroy the client sockets in the disposal.** The sockets belong to the client of the test, and a request in flight would fail. Their `close` also comes on a later turn.
- **Close undici's global dispatcher.** Node gives it only through the private `Symbol.for('undici.globalDispatcher.1')`.
- **Wait a fixed number of turns.** The number is a guess, and a slower close breaks it again.

## Consequences

- `cleanup()` and the disposal settle a few turns later than before, after the client has seen each close.
- This is the second copy of the socket-close tracking of the msw area. [Code copied into this package](../copied-code.md) records it, and backlog #5498 extracts it when a third place needs it.
- Node caches the local address of a socket at the first read. When code reads `localPort` of the socket of `fetch` before the interceptor gives it the real handle, the socket keeps no local port, and only the real socket pairs with the connection. The disposal then does not settle. Neither undici nor msw reads it then.
- A test of another file that runs at the same time, in the same process, and that connects to this server, is a client of the process too. The disposal also waits for its `close`.

## Confirmation

- The `fetch` case and the msw-passthrough case of the context failed in 3 of 3 runs before commit f38211cf, and they pass after it (released in 0.8.98).
- A mutation that removes the wait made both cases fail. A mutation that changes `Promise.race` to `Promise.all` made the passthrough case hang.
- The defect class and the mechanism are those of [ADR 0028](./0028-an-interceptions-disposal-waits-until-the-client-has-closed-each-connection-that-the-server-closed.md), which is accepted.

## Amendment 2026-11-24 (#5542): the disposal destroys the client sockets that it waits for

Decision-makers: the zukhruf session mutex-07, which decided from the evidence.

After a `fetch`, the disposal did not settle when nothing else kept the event loop alive. undici keeps an idle keep-alive socket unref'd. After the server closed its side, the event loop ended before the client socket read the server's FIN, so the socket never emitted `close`, and the wait stayed pending. A script whose last await is the disposal ended with exit 13, "Detected unsettled top-level await", in 3 of 3 runs, also behind an msw passthrough. A `node --test` file that awaits each test, with the disposal as the last await of its second test, failed with "Promise resolution is still pending but the event loop has already resolved" in 3 of 3 runs. context-compiler's `apps/what-is-going-on/src/testing/reader-cases.ts` failed in the same way with `@zukhruf/testing` 0.8.100. The defect came with commit f38211cf (0.8.98). The msw disposal does not have it: `server.close()` of msw destroys its sockets, and a socket that closes keeps the event loop alive until it emits `close`.

### Decision

The disposal destroys each client socket of the process that it pairs with a connection that the close destroyed, and then waits, as before, for the first `close` of each pair. The server has already destroyed the other side of these connections, so a client can send no more requests on them. A request in flight fails in either case. undici sees the `close`, and its next request opens a new connection. The disposal settled in about 1 ms.

### Considered Options

- **Call `ref()` on each paired client socket for the wait.** undici owns the ref state of its sockets. After the response, undici resumes the client in an `Immediate`, and `resumeH1` calls `socket.unref()` on the idle socket after the disposal called `ref()` (Node 26.13, `node:internal/deps/undici/undici:8059`). At `beforeExit`, `hasRef()` of the socket was `false`, and the script still ended with exit 13 in 3 of 3 runs.
- **Keep a timer or another handle of our own alive for the wait.** It keeps the event loop alive, but it does code by hand that `destroy()` already does, and the wait still depends on when the client reads the FIN.
- **Destroy the client sockets in the disposal.** The first decision refused it because a request in flight would fail. That request fails anyway, because the server has destroyed its side. Its `close` came within the wait, so undici clears its timer before the next test fakes the timers. This option is now the decision.

### Confirmation

- Red before the fix, in `src/http/http-server.integration.test.ts`: "disposal after a fetch settles in a process that nothing else holds open" failed with exit 13 and "Detected unsettled top-level await". "in a file that awaits each test, a test whose last await is the disposal after a fetch passes" failed with "Promise resolution is still pending but the event loop has already resolved". Both pass after the fix, with the three guards of #5449: the `fetch` timer case, the msw-passthrough timer case, and the case of a client in another process.
- Mutations, each in memory with the `mutate.mjs` of write-test: the fix removed made both new tests fail. `ref()` in place of `destroy()` made both new tests fail. No wait for `close` after `destroy()` made both timer cases fail. `Promise.all` in place of `Promise.race` made the passthrough case fail. A wait for connections with no client socket in the process made the out-of-process case fail. 7 of 7 caught.
- The second copy of the socket-close tracking, in `src/msw/msw.ts`, does not get this fix: its `server.close()` destroys its sockets already, and a script whose last await is its disposal after a `fetch` of a mocked response ended with exit 0 in 3 of 3 runs. [Code copied into this package](../copied-code.md) records the difference.
