# A background server owns its connections

Some modules read an origin when they load. For example, a module creates a remote key set from an environment variable. Every test in the file then uses the same server. No test can dispose it: the module still reads the origin after that test ends, and a test file has no `after` hook. Thus the server must listen until the process exits, and it must not keep the process running. `server.unref()` is not sufficient, because each open connection keeps the process running on its own. With one idle connection, a process with an unref'd server ran for more than 25 seconds. With its connections unref'd too, the process ended after 277 milliseconds. Thus `background(handler)` unrefs the server and each connection that it accepts, and returns only the origin.

## Considered Options

- **`start`, then `handle.server.unref()` in the test.** The connections keep the process running: until the keep-alive timeout after each response, and until the headers timeout for an idle connection.
- **`--test-force-exit`.** It ends every test process, also a process that leaks a different resource. A leak then gives no sign.
- **A disposable handle.** `await using` at the top level of a module disposes the server when the module finishes loading, before its tests run. Without a handle, TypeScript refuses `await using`.
- **The native `server` in the result.** A test could close it, or ref it again. No consumer reads more than the origin.

## Consequences

- When nothing else keeps the process running, it ends, also while a client of the server waits for a response. A client in the same process keeps the process running until its response arrives, because the client's own socket keeps it running.
- Use `start` when only one test reads the origin. A background server is for a module that reads the origin across tests.
