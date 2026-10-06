# The time limit of skip if busy counts only the wait for a holder

`skipIfBusy({ waitAtMost })` gives up when the key stays busy for longer than `waitAtMost`. A lock store with a coordinator can be slow to give its first answer: it connects, a campaign runs, or the leader is frozen. In a test, no leader served, and `skipIfBusy({ waitAtMost: 100 })` waited 1027 ms. Thus the docs promised a limit on the total time that the code did not keep. The code is correct, and the docs now tell its rule. The limit starts when the lock store answers that the key is busy. `{ acquired: false }` tells the caller that another holder had the key, and a cron job skips because of it. A slow answer does not show a busy key, so `skipIfBusy` does not give up because of it. A caller that needs a limit on the total time gives a signal, and the call then rejects ([ADR 0008](./0008-a-caller-cancels-an-acquire-mode-gives-up.md)).

## Considered Options

- **A limit on the total time of the call.** The timer would start at the call, and the mode would give up during a slow first answer. Then `{ acquired: false }` could tell of a holder that does not exist, and a cron job would skip a run that nobody does. Also, `waitAtMost: 0` would need a special meaning: one attempt with no limit.
- **A second limit for the first answer**, for example `answerWithin`. When it ends, the mode would give the same wrong result. A signal already limits the total time, and its rejection tells the truth: the caller does not know if the key is busy.

## Consequences

- The first call to a lock store with a coordinator can take longer than `waitAtMost`. When the leader is frozen, the call waits until the leader continues or stops.
- To limit the total time, give `signal: AbortSignal.timeout(ms)` too. When that signal aborts, the call rejects with a `TimeoutError`. It does not give up.
- A test pins the rule: a lock store whose first answer comes after the limit still grants a free key.
