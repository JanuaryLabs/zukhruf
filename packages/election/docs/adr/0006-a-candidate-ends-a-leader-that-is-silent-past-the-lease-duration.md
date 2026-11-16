# A candidate ends a leader that is silent past the lease duration

Status: Proposed 2026-11-15 for the owner's review (backlog #4371). Revised the same day: the deadline of the heartbeat starts the kill, not a count in each try. Built 2026-11-15.

On one computer, the claim of `SqliteElection` is a kernel file lock. Only the end of the process of the leader frees it (research 12-13 §G). Each supervisor that finds a hang ends the process: systemd's watchdog sends a signal, and the kubelet restarts the container. A cluster fences a silent peer the same way: Pacemaker's STONITH turns it off (research 12-13 §E, §G). Thus a reader of the leader's pipe ends a hung leader. A reader is a candidate that waits for the claim ([ADR 0007](./0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md)), or an observer ([ADR 0009](./0009-a-process-that-does-not-campaign-observes-the-leader.md)). Then the kernel frees the claim, and a candidate wins it.

A reader holds a connection to the `address` of the leader record ([ADR 0005](./0005-the-leader-record-names-the-process-and-the-pipe-of-a-term.md)). It keeps one deadline: `leaseDuration` of the record after the connect, and again after each heartbeat ([ADR 0004](./0004-a-leader-renews-its-term-with-a-heartbeat-on-a-pipe-that-it-serves.md)). When the deadline comes, the reader calls `process.kill(processId, 'SIGKILL')` with the `processId` of the record. It never kills on a period: one deadline gives at most one kill.

What the kill gives:

| Result              | What the reader does                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The kill is sent    | The process ends. The kernel frees the claim and closes the pipe. The close is the push of ADR 0007: a candidate tries at once, and an observer reports `'ended'`.                                                      |
| `ESRCH`: no process | The process ended already. Its close comes, or came. The reader goes on as after a sent kill.                                                                                                                           |
| `EPERM`: refused    | The process belongs to another user. The reader does not end it. It sets no new deadline and waits only for the close, or for the end of its campaign. The leader leads until it runs again, or until its user ends it. |
| Another error       | The campaign rejects with that error, and the `left` promise of an observer rejects. Only the two codes above are expected (EAFP).                                                                                      |

The kernel lets a process send a signal only to a process of the same user. A reader that runs as root can end a leader of any user.

A reader never sends the kill to its own process: a record that names `process.pid` of the reader is refused, as `EPERM` is. That process runs the reader, so it is not hung, and a kill would end the reader with it. A heartbeat of its own leader can be late, for example when the leader's clock and the reader's clock differ.

`SIGKILL`, because it is the only signal that ends a stopped process: POSIX keeps each other signal pending until `SIGCONT`. A handler of `SIGTERM`, for example of `@zukhruf/shutdown`, runs on the event loop, so it never runs in a process whose event loop is blocked. The kubelet also sends `SIGKILL` after its grace time.

A reader ends only a process whose pipe it holds open. Process ids are used again: in research 20j, arm B kept a dead row forever because its process id named a live process (S3). A process that ends closes its pipe. Thus, while the connection is open, the process id in the record names the process at the other end. The rule also keeps the kill to the same user, because the default folder of the pipe has the mode `0700` (research 20a P5).

After the kill, the candidate tries the claim again. It does not first ask `FileLock.check`. The try is the real operation (EAFP). The check also holds a shared lock for a moment, and a `tryLock` at that moment returns `false` (`@zukhruf/fs` README).

## A hung leader that runs again

With `SqliteElection`, a new term starts only after the kernel frees the claim, so only after the old process ended. Thus a hung leader never runs again after a takeover. When it runs again before the deadline, it sends its heartbeats, and it still leads: its term did not end, and its `term.signal` does not abort. When the kill was refused, the same is true.

A backend whose store takes the claim away by time is different. There the old leader can run again after a new term began. Its `watch` calls `lose`, and its `term.signal` aborts with `LeaseLostError` when its event loop runs. Before that, it can still act. A resource that it writes to refuses those writes only when it is fenced: the leader makes its tokens with `EpochTokenSource` of `@zukhruf/fencing`, and the resource refuses a token lower than the highest that it accepted ([ADR 0002](./0002-a-term-is-a-lease-on-leadership-with-no-fencing.md)).

## Considered Options

- **Accept the hang: each caller's signal ends its own wait.** Pool ticket 13 rejected it: each job of the computer waits.
- **Ask first with `process.kill(pid, 0)`.** It is a predicting check, and a used-again process id makes it answer "alive" for a dead leader (research 20j, arm B, S3).
- **`SIGTERM`, then `SIGKILL` after a grace time.** A hung process cannot run its handler, so the grace time only makes the takeover later.
- **`FileLock.check` after the kill, before the next try.** See above.
- **The kill of a process that the record names, only while its pipe is open, when the deadline of the heartbeat comes.** This option was selected.

## Consequences

- A takeover after a hang takes `leaseDuration` after the last heartbeat, plus the time of the kill and one try: about 15 s with the defaults. A reader that connected after the hang counts from its connect.
- The candidates and observers of one group must run in one PID namespace and see one `/tmp`. A reader in a container that shares the directory but not the process ids can end a wrong process. A reader that does not see the default folder of the leader cannot connect, so it ends nothing.
- A leader that the debugger stops for longer than `leaseDuration` is ended. Give a longer `leaseDuration` to debug a leader.
- The followers of `@zukhruf/mutex` and of `@zukhruf/single-flight` end a hung leader through an observer ([ADR 0009](./0009-a-process-that-does-not-campaign-observes-the-leader.md)).
- Windows: `process.kill` ends the process there, and the lock of SQLite ends with it [inference, not run].
