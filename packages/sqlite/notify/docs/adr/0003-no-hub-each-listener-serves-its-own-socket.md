# No hub: each listener serves its own socket

Changed in part on 2026-11-15 (#4396) by [ADR 0010](./0010-the-trim-wakes-the-laggard-and-a-dead-listener-is-forgotten-once-its-rows-are-gone.md): a sender also wakes the laggards at its trim, so a dead listener on a channel that nobody sends on is found too. After a `notify` in the caller's transaction, the sender reads on the next microtask whether a dead listener's rows are gone, and removes them again in each `notify` until they are. Only then does it remove the socket file. The rest of the decision below stays true.

The wake must reach each listening program. Two shapes fit the contract with the table (research 19 §4). In a hub, an elected program serves one socket, and each program connects to it. With no hub, each listener serves its own socket and writes its address in the file, and a sender connects to each address. `@zukhruf/mutex` and `@zukhruf/single-flight` use a hub.

The measures (research 20c and 20e, macOS and Linux):

- Both shapes wake a listener in 0.07 to 0.65 ms at p50, and cost 0.01 to 0.05 % of a core when idle (research 20c M1, M3).
- A hub that hangs gives no `close` and no error. For as long as it hangs, 99.0 to 99.3 % of the reads come by the backstop, up to about 1 s late, for every program (research 20c M5, 20e R1).
- With no hub, a listener that is killed or hangs changes nothing for the others. The sender held at most 14 KB for a listener hung 3 s (research 20e R1).

Postgres has no hub: the sender signals each listening session itself (`async.c:70-80`). Android Room has a hub, but its hub is a service of the platform, so it needs no election (research 20g).

## Decision

No hub. Ezz approved it on 2026-11-14 (ticket 20, "go ewith recomendation").

- Each listener serves its own socket and writes its address and its position in `zukhruf_notify_listener`, and its channels in `zukhruf_notify_channel`.
- A sender reads the addresses of the channel inside its transaction. The read costs 0.002 to 0.015 ms at p50 for 1 to 50 listeners, and a listener that registered while a sender sent got its first row by a wake in 0.8 to 2.1 ms (research 20e R2). A sender that read the addresses only at its start gave a late listener its rows by the backstop alone (research 20c M8).
- A sender keeps one connection to each address. Each connection has at most one wake in flight and at most one owed wake, written when the first is flushed. A hung listener then costs 4 to 5 bytes, against 582 to 589 KB with no limit, and rows committed in one turn of the event loop are not delayed (research 20e R3: a plain skip delayed them about 200 ms).
- The sender's connections do not keep its program alive.
- A sender that gets a refused connect or a `close` removes that listener's rows and its socket file in its next transaction. Under churn with 3 senders and 2 to 10 listeners, 0 rows were missed, read twice or out of order, and 0 files were left (research 20e R4).
- A listener killed after the last send of every sender keeps its row until some sender sends again. That send pays one failed connect, about 0.02 ms, and removes it (research 20e, "R4 under starvation"). The row delivers nothing wrong, so it stays.
- A listener in the sending instance gets its wake with no socket.

## Considered Options

- **A hub, elected as in `@zukhruf/mutex`.** One program that all depend on. A hub that hangs stalls each wake of every program, and nothing tells them. It needs the election and the connection code of #2496.
- **No hub, with the addresses read once at the sender's start.** A listener that comes later gets its rows only by the backstop (research 20c M8).
- **No hub, with the addresses read in each transaction.** This option was selected.

## Consequences

- No election, and no program that all depend on. A listener that hangs hurts only itself.
- Each listener needs its own address: a socket path within the path limit, or a pipe name ([ADR 0007](./0007-the-socket-folder-is-short-and-belongs-to-one-user.md)).
- A send costs one read of the listener table and one write for each listener of the channel.
- A dead listener's row holds back the trim until a sender removes it, at most about one second after the next send on any channel ([ADR 0010](./0010-the-trim-wakes-the-laggard-and-a-dead-listener-is-forgotten-once-its-rows-are-gone.md)).
- The election's own gap, the push for "the owner ended", is not this package. It is ticket 13.
