# A process that creates its run's reaper takes a creator lease first, and a new reaper waits for its first hold until that lease is gone

Status: Accepted 2026-11-26 (backlog #5739).

Decision-makers: the zukhruf session mutex-a9, from probes on the engine and the sources of the top performers, within the paper that Ezz accepted on 2026-11-26. He gave the choice between the two designs below back with "Measure yourself and decide and take action".

A test process holds the reaper of its run before it creates anything on an engine (ADR 0020, item 7). The process that creates the reaper starts it and then holds it. A process that dies between the start and its hold leaves a reaper that no holder ever comes to. Before this decision, the reaper waited for a first holder for a fixed time (`firstHolder`, 60 s), and then cleaned the run. A timer cannot tell a slow creator from a dead one, and the paper of #5739 removes such timers.

Two designs end the wait on an event. The paper (item 5) chose the first, and the build plan the second:

- **The attach as the first hold.** The creator attaches to the reaper's standard input before it starts it, as `docker run -i` does, and that attach is its first hold.
- **A creator lease.** Before it creates the reaper, the creator takes an engine lease (a `cat` container on its attach, which the engine removes when the process ends). The reaper names the lease, and waits for its first hold until a hold comes or the lease is gone.

## Decision

1. **A process that finds no reaper of its run takes a creator lease, then creates the reaper with the lease's id** (`REAPER_CREATOR`), and ends the lease when its hold has its answer. The lease has the run's label and the kind `creator` (`dev.zukhruf.testing.lease`). A process that finds the reaper takes no lease: most holds find it, and a lease costs a create, an attach and a start.
2. **The first start of a reaper waits for its first hold until a hold comes or its creator lease is gone.** It starts `docker events --since <now> --filter container=<lease> --filter event=destroy` and then inspects the lease once, so a removal between the two is not lost (a Kubernetes informer lists and then watches). The wait makes no engine call while it waits.
3. **A start after a restart of the engine or a kill of the reaper keeps its wait for a first holder** (`firstHolder`). A mark in the reaper's writable layer tells such a start from the first one. The restart cuts the holds and ends the creator lease, but the holders whose process lives take their hold again at once. The one outer bound of the paper replaces this wait in a later step of #5739.

## Considered Options

- **The attach as the first hold (paper item 5).** It needs no extra container, and the end of the attach comes fast. But a reaper that another process starts with no attach (the start of a `created` reaper by another reaper), and a reaper after a restart, both read a standard input that never ends. Such a reaper reads "no creator" as "a creator that holds", and never cleans. The atomic bind of the leaders that do this (Erlang's `spawn_link`, `CLONE_PIDFD`) has no equivalent in the Docker API, where `docker run` is three calls: create, attach and start. testcontainers-go handles a reaper left `created` in that window with a timer of 10 s.
- **Keep the wait for a first holder (60 s).** A timer is the one tool of Ryuk (`RYUK_CONNECTION_TIMEOUT`), and it cannot tell a slow creator from a dead one.

## Consequences

- A process that creates its run's reaper waits for one more container: 212 to 299 ms (5 probes), once for each run on each engine.
- A process that dies before its hold leaves a reaper that cleans the run as soon as the engine removes the lease: 94 to 110 ms after its process died (5 probes).
- A test that creates a reaper itself names a creator lease that does not exist (`GONE_CREATOR`), as for a creator that was killed before its hold.
- A lease that its process created but never started protects nothing, since no reaper names it, but no event removes it. The collection of orphans, a later step of #5739, removes it.

## Confirmation

Tests in `src/docker/reaper.integration.test.ts`, each red on the code before this decision (landed first as `todo: '#5739'`, as this repository lands a red test), then green:

- "a test process killed after it created its run's reaper and before its hold leaves a reaper that removes itself with no wait for a first holder": the proxy holds the hold of the process, the test kills the process, and the proxy refuses the hold. Red: the reaper waited its first-holder time (1 h in the test) until the test's limit. Green: 2.8 s.
- "a reaper that its creator left created, and that another process starts after the creator died, removes itself with no wait for a first holder": the proxy holds the start of the reaper, which comes after the start of the lease. Red: no lease, so no second start. Green: 2.9 s.
- "the process that creates its run's reaper takes one creator lease and leaves none once it holds, and a process that finds the reaper takes none". Red: no lease create. Green: 1.2 s.
- "a reaper whose creator is gone before any hold removes the run's objects with no wait for a first holder, and exits" (was: "… after its wait for a first holder"). Green: 2.4 s.
- "a reaper whose creator lease ends after the reaper looked at it ends its wait for a first hold at that end": the test owns the lease, waits until the reaper's look arrived and its `docker inspect` exited, then ends the lease, so only the watch can end the wait. Green: 11.8 s.
- The test of a late create (docker-global-setup.integration.test.ts) skips the events of a lease: a creator lease has the run's label, as a process lease has, and is no object of a test.

Mutation proof (write-test's `mutate.mjs`, each mutant in memory, 13 runs):

- CAUGHT: a first start that waits like a restart (by the tests of a creator killed before its hold, of a `created` reaper started after its creator died, and of a creator gone before any hold); the watch removed (by the test of a lease that ends after the look); the look inverted (by the test of a creator gone before any hold); the mark of a start ignored at a restart (by the test of a restart with a late holder); a lease on every hold and a lease that is never ended (by the test of the leases).
- Not proven: that the reaper is given the id of its creator's own lease. With a wrong id, a new reaper ends its wait at once, and its creator's hold still comes within the grace of 2 s. A later step of #5739 removes the grace, and its tests prove this.

Probes on Docker Engine 29.9.3 (desktop-linux, 2026-11-26):

- A container whose creator attached before its start and was killed: its standard input ends in 22 to 59 ms. A container started with no attach, or restarted after its attach ended: its standard input does not end (`OpenStdin=true StdinOnce=true`).
- A creator lease of a killed process: its `destroy` event comes in 94 to 110 ms. Taking it costs 212 to 299 ms.
- `docker events --since T` gives a `destroy` that came after T and before the subscription.

Sources of the top performers: Docker CLI `cli/command/container/run.go` (create :150, attach :186, start :206); moby `daemon/attach.go:49` (`CloseStdin` from `StdinOnce`), `daemon/internal/stream/attach.go:69-71` (the end of the attach closes the standard input), `daemon/container/monitor.go:17-28` (a new input pipe at each start); testcontainers-go `reaper.go:317-342` (`checkStale`, 10 s); moby-ryuk `reaper.go:308-349` (the connection timeout); containerd `client/lease.go:37-53` (a lease before its resources); Kubernetes `pkg/controller/garbagecollector/garbagecollector.go:431-450` (an owner is absent when a live GET does not find it); Erlang/OTP `erlang.erl:6362` (`spawn_link` links atomically).
