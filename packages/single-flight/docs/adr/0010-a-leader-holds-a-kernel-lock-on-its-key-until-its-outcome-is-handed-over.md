# A leader holds a kernel lock on its key until its outcome is handed over

This decision supersedes [ADR 0009](./0009-the-next-coordinator-skips-the-grace-window-after-a-clean-shutdown.md).

Before this decision, the only record that the work of a key runs was the map of flights in the coordinator. That map is in memory. When a coordinator stopped, the next coordinator started its term with a grace window of 500 ms. In the grace window, the leaders reasserted their flights. After the grace window, the coordinator refused each reassert. Thus a leader lost its flight while its work still ran in these cases:

- Its process was frozen past the grace window, for example by `SIGSTOP` or a debugger.
- Its process was busy past the grace window, for example in a long synchronous step, so it did not read its socket.
- It disposed its `SingleFlight` while its work ran. Its connection closed, and the coordinator interrupted the flight at once. This case needs no change of coordinator.

In each case, the next call of the key led a new flight, and the work ran a second time beside the first one. A customer saw it as the error "Checkpoint messages:attachments is in use by another run" (backlog #2573).

A timer cannot tell a frozen process from a dead one. The kernel can. On one host, the kernel keeps a file lock while its process lives, also while the process is frozen. It frees the lock when the process dies. Chandra and Toueg (1996) call such a detector a perfect failure detector: it never suspects a process that lives (strong accuracy), and it finds each process that died (strong completeness). The processes of a directory are on one host, because the directory must be on a local file system.

## Decision

The process that runs the work of a key holds a kernel lock on that key, the **key lock**.

- The key lock is a `FileLock` of `@zukhruf/fs` on the file `execution-locks/<SHA-256 of the key, in hex>.lock` in the directory. The folder keeps the key `flight` away from the file `flight.lock` of the election. The digest keeps two keys that differ only in case apart: APFS and NTFS read `Sync` and `sync` as one file name. The files are never removed. The directory keeps one file for each key that ever led.
- A run that the coordinator tells to lead first takes the key lock. The first try is synchronous, when the `lead` answer arrives, so only microtasks separate it from the start of the work. While another process holds the lock, the run tries again every 10 ms. The run leads only when it holds the lock. Until then, it is a run that waits: a lost connection sends it again as a new call, and a cancel, a dispose or a file fault ends it. Its work never starts.
- When the run holds the key lock, it reads the epoch of the last term on disk (`SqliteElection#lastEpoch()`). An epoch that is newer than the term of its lead token shows a stale grant: the coordinator that gave it is gone, and the next coordinator can have let another run lead. The run then frees the key lock and goes again as a new call. Raft refuses a request with a stale term in the same way (Ongaro and Ousterhout 2014, §5.1). The read is sound, because the election writes the epoch of a new term before its coordinator answers anything. Thus a key lock taken under the current epoch is a key lock that the next coordinator sees.
- The leader frees the key lock only when two conditions are true. Its work settled, and its flight needs nothing more from this process: the coordinator acknowledged its landing, its lease was lost, or its `SingleFlight` closed. A cancel or a dispose alone never frees the key lock.

The coordinator reads the key lock, and the leader's `tryLock` decides:

- A run of a key with no flight in progress, while another process holds the key lock, waits. This is a **parked run**. It is decided again in the step that starts the next flight of its key, and then it joins that flight. Thus a landing that arrives right behind a reassert reaches it. When the key lock frees, it is decided again, and it leads with the token that it got first. A rejoin waits in the same way.
- Each key with parked runs has one watch. It checks the key lock every 10 ms, on a timer that does not keep the process alive (`poll` with `ref: false`, from `@zukhruf/async`). The watch stops when the key lock frees, when a flight of the key starts, when no parked run of the key still waits, or when the coordinator closes.
- The coordinator accepts a reassert at any time. A reassert with the token of the flight in progress hands that flight to the new connection, and the flight keeps its joiners. A reassert with a newer token wins, and the older flight is lost. A reassert with an older token is refused.
- For each key, the coordinator keeps how the latest reasserted flight ended, for a rejoin that comes after its end.
- The check of the key lock is advice only. When the check fails, the key counts as not held: the run leads, and the `tryLock` of its leader decides. A fault of the check never refuses a run or a rejoin, so it never closes a connection.

There is no grace window. A new coordinator answers a run of a key that no process holds at once. The safety does not come from a timer. A stale grant is fenced: the leader's `tryLock` and its read of the epoch refuse it. Chubby does the same with its sequencers, and it calls its lock-delay, a timer, an imperfect protection (Burrows 2006, §2.4). The option `graceWindow` is removed. The coordinator no longer records a clean shutdown, so ADR 0009 does not apply any more.

## Considered Options

- **A longer grace window, or one that a leader renews.** This is Chubby's lock-delay. A process can be frozen for longer than each timer, so a timer is not a lock. A longer window also makes each call after a failover wait longer.
- **Fencing at the resource only.** Kleppmann (2016) shows that a process pause can last past each lease, and that the resource must refuse a stale fencing token. The work already gets the token of its lease, so a resource can do that. But a second run of the work still starts beside the first one, and a resource without fencing still sees two writers.
- **The coordinator keeps its map of flights on disk.** The next coordinator then knows the flights of the last term. But it cannot tell a frozen leader from a dead one, so it must still wait for a timer.
- **A socket for each leader.** The coordinator would connect to the leader to see that it lives. A frozen leader cannot accept or answer, so it looks dead.
- **The connection is the term.** A lead would count only on the connection that got it, with no read of the epoch. A grant that a dead coordinator gave before the next term started would then lead beside a newer grant. The read of `lastEpoch()` after the lock closes that gap.
- **The coordinator holds the key lock for the leader.** When the coordinator stops, the kernel frees its locks, and a leader that still runs loses its key.
- **The lock store `SqliteStore` of `@zukhruf/mutex`.** It holds a kernel lock for each key too. But a domain package never imports another domain package (rule 5 of the [workspace ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md)). `FileLock` is in `@zukhruf/fs`, a lower layer.
- **A kernel lock on each key, held by the process that runs the work, until its outcome is handed over.** This option was selected.

## Consequences

- A leader keeps its flight while its process lives. A frozen leader or a busy leader keeps its key until it continues, reasserts its flight and lands it, or until its process dies. The tests in "A single flight across processes when a leader is frozen past a failover" show this.
- A run of a key with a frozen leader, or a leader that hangs, waits with no limit. A caller that wants a limit gives a `signal`. A run of another key never waits for it.
- A leader that disposed its `SingleFlight` while its work runs keeps its key until the work ends. Its joiners get `FlightInterruptedError`, because a disposed leader cannot send its outcome. The next run of the key leads after the work ended.
- Two flights of one key that follow each other wait about 10 ms between them. The leader frees the key lock only when it reads the acknowledgment of its landing, and a run that comes before that waits for one check of the watch. Backlog #2646 records a fix for the case in one process.
- The directory has the folder `execution-locks`, with one file for each key that ever led.
- `LeaseLostError` now means that the outcome of the leader reaches no joiner. It does not mean that the work ran beside another run: a leader that lost its lease keeps its key until its work ends ([ADR 0007](./0007-a-work-error-after-a-lost-lease-rejects-with-leaselosterror.md)).
- A stale grant can still take the key lock first. Two paths can give a newer lead of a key while an older leader holds its key lock, or is about to take it. The connection of the older leader ends right after its `lead` answer, so the coordinator interrupts its flight before the leader took the lock. Or a check of the key lock fails, and the coordinator does not see the lock. Then the older leader runs first. Its reassert is refused, because the newer token wins, and its call rejects with `LeaseLostError`. The newer leader takes the key lock only after the work of the older leader ended. The work then runs twice, one run after the other, never one beside the other.
- A process that runs alone answers its first call at each epoch as fast as at the first epoch: the probe of backlog #2549 measured 14 to 22 ms. This closes #2549.
- The coordinator no longer records a clean shutdown with its election, and it no longer writes `flight.lock.clean`.
