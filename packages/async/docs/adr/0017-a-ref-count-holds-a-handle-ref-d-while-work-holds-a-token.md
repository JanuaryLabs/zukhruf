# A ref count holds a handle ref'd while work holds a token

Four places kept a Node handle ref'd while work was in use, and unref'd it when idle, so an idle client did not keep the process alive (#4614): `ChannelsInUse` of `@zukhruf/docker` (`src/ssh-engine.ts`), the count of sessions of `DockerHost` in `@zukhruf/testing` (`src/docker/host.ts`), `RemoteLockClient#updateRef` of `@zukhruf/mutex`, and `FlightClient#updateRef` of `@zukhruf/single-flight`, a copy of the one of mutex. The first two keep a count; the last two compute "in use" from their own state. Ezz ruled on 2026-11-18 that the four are one knowledge, strike 3 of the Rule of Three: "strike 3. are we going to create new package for this or include this in one of the existing packages? you need to see how other languages do this."

Only runtimes with an event loop have the idea that a ref'd handle keeps the process alive. libuv keeps a flag on each handle, not a count (`UV_HANDLE_REF`, `uv_ref` and `uv_unref`, `src/uv-common.h`), and the loop lives while an active, ref'd handle exists. So Node counts on top where it shares one handle: the IPC channel of a child process refs at the first counted use and unrefs at the last (`Control#refCounted` and `#unrefCounted`, `lib/internal/child_process.js`), and a `MessagePort` refs while it has `message` listeners (`lib/internal/worker/io.js`). Deno refs and unrefs each pending op and timer (`core.refOp`, `Deno.refTimer`). Threaded runtimes say it with threads: a daemon thread in Java and a background thread in .NET do not keep the process alive. Go has no such idea: a program ends when `main` returns. Neither Go nor .NET names it, so the name comes from libuv and Node.

## Decision

This package exports `RefCount` and the type `Referable` (anything with `ref()` and `unref()`). Ezz approved the home and the API on 2026-11-18 ("Approve: async RefCount (Recommended)").

```ts
import { RefCount } from '@zukhruf/async';

const refs = new RefCount(client);
using _request = refs.hold();
```

- **`hold()` gives a token, a `Disposable`**, as `WaitGroup.add()` does. The first hold refs the handle; the dispose of the last token unrefs it. A second dispose of one token changes nothing.
- **The constructor does not touch the handle.** A docker client stays ref'd until the ping of its connect is released, and testing unrefs its client at once: each consumer sets the start itself.
- **What counts as work stays with each consumer**: a channel that opens or is open (docker), a session or a forward (testing), a request that waits for its answer (mutex), a run or a landing that waits (single-flight).
- **No `size` and no `reapply()`.** No consumer reads the count. A handle that a supervisor replaces after a lost connection keeps its ref through the supervisor, not through the count (#4668).

## Considered Options

- **A new package.** It would hold one class beside its sibling: `WaitGroup` counts disposable tokens in this package (ADR 0015), and every consumer already depends on `@zukhruf/async`.
- **`@zukhruf/ssh`.** It fails the test of a package with no consumer: two of the four places hold no SSH client, and Node's http2 does not unref an idle session either.
- **A count with `ref()` and `unref()` methods instead of tokens.** A double release would count twice and unref a handle in use; a token counts once.
- **`reapply()`, to set the state again on a replaced handle.** It covers a gap of `ConnectionSupervisor` in mutex (and its copy in single-flight), which forgets the last `ref()` or `unref()` when it replaces a lost connection. Ezz chose to fix the supervisor (#4668).

## Consequences

- `RefCount`, `Referable` and the word ref count are new in this package (see [CONTEXT.md](../../CONTEXT.md)).
- The four places move onto `RefCount` in their own commits, and the copy ledgers drop their rows: `packages/testing/docs/copied-code.md` and the `#updateRef` part of `packages/single-flight/docs/copied-from-mutex.md`.
- docker keeps its `RefState`: Node's http.Agent calls `ref()` and `unref()` on a socket many times (`keepSocketAlive`, `reuseSocket`), and each change of state must move the count once. That is docker's knowledge, as Node keeps the same thing in `Control`, not in libuv.
