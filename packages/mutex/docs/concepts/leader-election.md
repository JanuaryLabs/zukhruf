# Leader election

The socket lock store needs one coordinator for all processes on a host. Leader election selects that coordinator. The module is `mutex/leader-election`. It does not import the mutex, and you can use it alone ([ADR 0002](../adr/0002-election-is-not-part-of-the-mutex.md)).

## What leader election must do

1. **Make one claim win.** Many candidates try at the same time. Exactly one must win.
2. **Find a leader that stopped.** Then another candidate can win.
3. **Never have two leaders.** Two leaders give two coordinators, and both grant the same key.

## How this module does it

- **The claim.** A candidate starts an exclusive SQLite transaction on `<directory>/leader.lock`. Only one connection can have that transaction. The leader keeps it open for its full term.
- **A leader that stops.** The operating system kernel keeps the SQLite file lock. When the leader process stops, the kernel removes the lock, also after `SIGKILL`. Then the next campaign wins.
- **The epoch.** The winner reads `<directory>/leader.epoch`, adds 1, and writes it back. Only the winner can do this, so the epoch always increases.
- **A campaign does not block.** A candidate tries once, waits `pollInterval`, and tries again until `timeout`. The process continues other work between attempts. (A SQLite busy timeout would stop the event loop of each candidate.)

```ts
import { LeaderElection } from '@zukhruf/mutex/leader-election';

const election = new LeaderElection('/var/lib/my-app/election');
await using leadership = await election.campaign({ timeout: 1000 });
if (leadership) {
  console.log(`I am the leader, epoch ${leadership.epoch}`);
}
```

## Rules

- **Do not delete `leader.lock`** while candidates run. A new file has no lock on it, so a second candidate wins and two leaders exist.
- **Stop the server before you resign.** The socket lock store closes its socket first and ends its term second. In the other order, the old leader can delete the socket file of the new leader.

## Failover in the socket lock store

When the leader stops, the kernel closes all connections to it. Then this occurs:

1. Each follower sees its connection close.
2. Each follower connects again or starts a campaign. One candidate wins and becomes the new leader with a higher epoch.
3. The new leader starts a **grace window**. During the grace window, it grants no keys.
4. Each holder **reasserts** its keys: it tells the new leader the keys and tokens that it holds.
5. Each waiter sends its request again.
6. After the grace window, the new leader grants keys to waiters.

The grace window prevents a waiter from getting a key that a holder still has. For two reasserts of one key, the higher token wins. A reassert after the grace window is refused, and that holder gets `LockLostError` when it releases the key.

The first leader of a directory (epoch 1) has no grace window, because no earlier leader had holders.

## Evidence

All results are from tests on macOS with Node 26:

- **A naive takeover is not safe.** Two servers that each did "connect, see `ECONNREFUSED`, delete the socket file, listen" both listened in 11 of 20 races. Clients were split between them.
- **`ECONNREFUSED` does not mean "no leader".** A live leader with a full connection queue also gave `ECONNREFUSED`.
- **One attempt is not enough.** With one attempt and no wait, 9 of 20 races had no leader. With retries, 60 of 60 races had exactly one leader.
- **A deleted lock file gives two leaders.** After `leader.lock` was deleted, a second candidate won while the first leader was alive.
- **A stopped leader is replaced fast.** After `SIGKILL` of the leader, the next candidate became the leader in approximately 10 ms.

The tests in `src/leader-election/leader-election.test.ts` check that exactly one of four processes wins, that a new leader has a higher epoch, and that a losing campaign does not block its process.
