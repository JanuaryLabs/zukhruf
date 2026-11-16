# A follower observes the leader, so a frozen leader is ended

A follower of the socket lock store reached the server of the leader, so it did not campaign until that connection closed. A leader that froze, for example during `SIGSTOP`, kept each connection open and answered nothing. Thus each follower waited forever, and no process could lead. Also, between two tries a process waited one poll interval, 10 ms. Thus a process under a leader whose server did not listen yet made 100 tries a second.

`SqliteElection` now has a heartbeat on the pipe of the leader, and an observer of the leader, after etcd's `Election.Observe` ([election ADR 0009](../../../election/docs/adr/0009-a-process-that-does-not-campaign-observes-the-leader.md)). The socket lock store uses them:

- A follower observes the leader from its `hello` until its connection closes. The observer reports `'closed'` when the leader left, and `'ended'` when it ended a leader that was silent for longer than the lease duration. When it reports one of them before the leader answers the `hello`, the follower closes its connection and continues as after a hang-up. After the `welcome`, the follower does nothing with the report: when the process of the leader ends, the kernel closes the connection of the follower too, and the follower connects again as after each death of a leader. Thus one path handles each death of a leader. The observer reports `'absent'` when the leader serves no pipe, for example a leader of a published version. Then the follower follows that leader as before.
- After a lost try, a process waits for the first of two events: the observer reports that the leader left, or the next step of a back-off ends. Then it tries again. The back-off is the back-off of the election: 25 ms, × 1.6, ± 20 %, at most 1000 ms (`Backoff` of `@zukhruf/async`). One observer lasts across the steps, so it also ends a leader that froze before its server listened.
- A try is one try of the claim: `campaign()` with no `timeout`. Before, it was a campaign of one poll interval.
- `SocketStoreOptions.pollInterval` is removed, with no alias. `leaseDuration` is added. The store gives it to `SqliteElection`, and the election writes it in the leader record. Thus each follower uses the lease duration of the leader. The default is the default of the election, 15000 ms.

## Considered Options

- **The 10 ms poll, and no observer.** This was the behavior before. A frozen leader stops each process forever.
- **A follower campaigns while it follows.** Each follower would hold two connections to one leader. Its campaign would win a term that it must serve at once, while it still follows the old server.
- **A time limit on each request.** A request can wait as long as its caller allows, so no time limit tells a frozen leader from a held key.
- **A new observer for each step of the back-off.** The longest step is approximately 1200 ms. An observer that lives for one step never comes to a longer lease duration. Thus a leader that froze before its server listened would never be ended.
- **An observer of the leader, and a back-off while no server listens, after etcd.** This option was selected.

## Consequences

- A follower ends a frozen leader after the lease duration of that leader. A survivor leads, and each holder reasserts its key in the grace window of the survivor. The test "a leader frozen past its lease duration is ended by a follower, a survivor leads, and the holder keeps its key" shows this.
- A process ends a leader that froze before its server listened, and then it leads. The test "a process ends a leader that froze before its lock server listened, and leads" shows this.
- A killed leader is replaced at once, as before: the kernel closes each connection to it. The test "a holder keeps its key when the leader dies, and a waiter enters only after it releases" shows this with the default lease duration.
- A follower that the leader welcomed keeps its connection when the leader's pipe closes and its server does not. The test "a follower keeps its connection when the leader leaves after the welcome, and leaves the close to the kernel" shows this. A follower whose `hello` has no answer gives up the connection when the leader leaves. The test "a process whose hello gets no answer gives up the connection when the leader leaves, and leads" shows this.
- A process whose leader serves no lock server yet makes no try until the leader leaves or a step of the back-off ends. The test "a process that lost its try waits on the leader, not on a timer, and tries again once the leader leaves" shows this.
- A leader that does not run for longer than its lease duration is ended too, for example during a long block of its event loop. Set `leaseDuration` above the longest pause of your processes ([election ADR 0006](../../../election/docs/adr/0006-a-candidate-ends-a-leader-that-is-silent-past-the-lease-duration.md)). A follower cannot end a leader of another user.
- After a kill of the leader, a process that lost its try waits one step of the back-off, 25 ms ± 20 %, before it reaches the new leader. Before, it waited 10 ms. The grace window, 500 ms by default, must be longer than the time that a holder needs to reconnect. The first five steps add up to approximately 395 ms.
