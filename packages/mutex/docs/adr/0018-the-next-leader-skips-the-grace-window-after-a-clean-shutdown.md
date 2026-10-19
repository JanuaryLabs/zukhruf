# The next leader skips the grace window after a clean shutdown

When a leader of the socket lock store stops, a failover occurs. The new leader starts with a grace window. In the grace window, the holders of the last term reassert their keys. Before this decision, each term after the first term of a directory had a grace window, also when the leader before it disposed its store and no process held a key. Then there was nothing to reassert, but the new leader waited all the same. Backlog #2647 measured it: two processes that run alone, one after the other, on one directory. Each one takes one key, releases it, and disposes its store. The second process took about 515 ms for its key, and the default grace window is 500 ms.

Only the leader knows that no process holds a key. Only the election knows which term comes just after which. Thus the leader tells the election, and the election keeps the record ([election ADR 0003](../../../election/docs/adr/0003-a-term-that-shuts-down-cleanly-tells-its-successor.md)). The lock server resigns its term with `term.resign({ clean: true })`, and the next term reads `term.afterCleanShutdown`. When it is `true`, `SocketStore` starts the next lock server with no grace window. PostgreSQL does the same with its control file: after a clean stop, the next start does no crash recovery. Here, the grace window is the recovery. The single flight had the same rule until its ADR 0010 removed its grace window ([single-flight ADR 0009](../../../single-flight/docs/adr/0009-the-next-coordinator-skips-the-grace-window-after-a-clean-shutdown.md)).

A lock server resigns clean only when its coordinator leaves nothing to recover (`LockCoordinator.leavesNothingToRecover`):

- No key is held. A waiter is not a holder: it sends its request again to the next leader.
- The grace window of the coordinator is over, or it had none. In its grace window, a holder of the term before can still reassert a key that this coordinator does not know yet.
- The term is not lost. The election records nothing for a lost term.

The lock server reads this in the step that drops its connections. It cannot read it later: each session that ends releases its keys, so after that no key is ever held. A grant cannot occur between the read and the drop, because the two steps run without a pause. A grant after the drop never reaches its process. That process sends its request again to the next leader.

The leader is also a client of its own lock server, over a socket. A release has no answer, so the leader can dispose its store before its lock server reads its last release. A first version of this decision thus read the key as held, and the next leader kept its grace window (516 ms, 565 ms and 515 ms in three runs of the test). Thus the connection of the leader to its own lock server (`OwnServerConnection`) closes in two steps. It half-closes the socket, and it waits until the lock server closes its side too. By then, the lock server read each request that the leader sent before. `SocketStore` closes its client before its lock servers, so the lock server reads the state after it read the last release of the leader. A follower still closes its connection at once: a leader that is frozen must not stop the disposal of a follower.

## Considered Options

- **Each term after the first has a grace window.** This was the behavior before. Each process that runs alone gets its first key about 500 ms late.
- **Resign clean on each close.** A leader that disposes while a follower holds a key would then remove the grace window. The next leader would refuse the reassert of the holder, and a waiter would get the key while the holder still works. The test "a leader that shuts down while a follower holds a key still lets a waiter enter only after the holder releases" fails with this option.
- **Read the state after the connections closed.** Then no key is held each time, also when a follower still works. This option has the same defect as the previous one.
- **Wait some event loop turns before the read.** The last release of the leader would arrive in most runs. But no fact tells that it arrived, and the number of turns depends on the platform.
- **Connect the leader to its own coordinator without a socket.** The leader would need no wait. But a socket keeps the process alive while the leader waits for a key, and an in-memory channel does not. The handshake with the own lock server would also change.
- **Read when the term starts to end, with the grace window and the held keys, after the own connection closed in two steps.** This option was selected.

## Consequences

- A process that runs alone, after a process that disposed its store with no key held, gets its first key at once. A probe with three such processes on one directory measured 24 ms, 16 ms and 15 ms for the first key of the terms 1, 2 and 3. Before, the terms 2 and 3 took 519 ms and 529 ms.
- A leader that disposes while a follower holds a key leaves a grace window to the next leader. The holder reasserts its key there.
- A leader that disposes while it holds a key itself can leave a grace window too. The leader does not reassert that key, so the next leader waits when it did not have to.
- After a stop without a disposal, for example a crash, the next leader keeps its grace window.
- A leader that disposes in its own grace window leaves a grace window to the next leader.
- `Connection.close()` returns a promise. `ConnectionSupervisor` waits for it, so `RemoteLockClient.close()` resolves after the own lock server read the last request.
- `MemoryStore` has a `holdsAnyKey` getter. The coordinator reads it.
- A directory of a socket lock store has one more file, `leader.lock.clean`, between a clean shutdown and the next term.
- Published versions (0.3.24 and older) never record a clean shutdown and never read one. In a directory that they share with this version, the term after one of them, and each term of one of them, keeps its grace window.
