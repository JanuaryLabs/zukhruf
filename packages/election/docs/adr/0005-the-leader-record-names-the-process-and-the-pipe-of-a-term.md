# The leader record names the process and the pipe of a term

Status: Proposed 2026-11-15 for the owner's review (backlog #4371). Not built.

A candidate and an observer must know three facts about the leader: which pipe to connect to ([ADR 0004](./0004-a-leader-renews-its-term-with-a-heartbeat-on-a-pipe-that-it-serves.md)), how long a silence to accept, and which process to end when the leader hangs ([ADR 0006](./0006-a-candidate-ends-a-leader-that-is-silent-past-the-lease-duration.md)). Node has no file lock API, so a candidate cannot ask the kernel for the process that holds the claim. POSIX `fcntl(F_GETLK)` gives it, but only outside Node (research 12-13 §G). Thus the leader writes the facts itself.

The winner of a claim writes the leader record, `<claimFile>.leader`, beside the claim file. It holds one JSON object:

```json
{
  "epoch": "7",
  "processId": 4242,
  "address": "/tmp/zukhruf-election-501/3f9c0a…",
  "leaseDuration": 15000
}
```

- `epoch` is the epoch of the term, as decimal text. It tells a reader which term the record is about.
- `processId` is `process.pid` of the leader. It is client-go's `holderIdentity`, and sqlite-notify keeps the same fact in its column `process_id`.
- `address` is `endpoint.address.path` of the pipe of the leader. The pipes package says to publish this path for the clients.
- `leaseDuration` is the option of the leader, in milliseconds. A reader uses the value of the record, not its own option. client-go does the same: `isLeaseValid` adds the `LeaseDurationSeconds` of the observed record to the time it observed the change (`tools/leaderelection/leaderelection.go`, READ).

The record has no `heartbeatInterval`. A reader keeps only the deadline, so it does not need the period ([ADR 0004](./0004-a-leader-renews-its-term-with-a-heartbeat-on-a-pipe-that-it-serves.md)).

The steps of `tryClaim` after it wins are, in this order: it writes the epoch to the disk, it listens on the pipe, and it writes the record. Then the term begins. Thus a record always names a pipe that listens, or listened. The write is an atomic replace with `atomicWrite` of `@zukhruf/fs`, so a reader never sees a part of it. It is not synced to the disk: after a power loss, no process of the old term lives.

The pipe has a plain name: 32 random hex digits, with the prefix `zukhruf-election`. Thus it is in the default folder of the user, `/tmp/zukhruf-election-<uid>`, with the mode `0700` (pipes ADR 0002). Another user cannot connect to it (research 20a P5). Its socket path has about 58 bytes, so it fits in the limit of 103 bytes for each directory. sqlite-notify names its pipes the same way and publishes the address in its table. A random name is never used again, so a connect to the address of an old record never reaches a new leader.

Nothing removes the record. A leader that removed it after its release could remove the record of the next leader. The next leader replaces it. A record of an older term names a pipe that is closed: a connect gives `ECONNREFUSED`, or `ENOENT` when the file is gone. A reader then waits a short back-off and tries again ([ADR 0007](./0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md)).

## Considered Options

- **The process id in the epoch file, for example `7 4242`.** [ADR 0003](./0003-a-term-that-shuts-down-cleanly-tells-its-successor.md) rejected a mark in the epoch file: a published candidate reads that file with `BigInt`, and this version rejects each text that is not decimal digits with a `SyntaxError`. A candidate of either version in the same directory would fail each campaign.
- **A pipe with a rooted name beside the claim file, as `lock.sock` of the mutex.** Its socket path grows with the directory, and above 103 bytes `new PipeEndpoint` throws a `RangeError`. A directory that works today would then fail.
- **The leader tells its process id on the pipe when a reader connects.** A hung leader cannot answer a reader that connects after the hang. Then no reader that started after the hang knows which process to end, and the group waits forever.
- **A record beside the claim file, written once for each term.** This option was selected.

## Consequences

- A directory of `SqliteElection` has one more file, `<claimFile>.leader`, and the default folder of the user has one socket file for each leader.
- A reader reads the record with `readFile`. The record is not the claim file, so the read keeps the lock of the leader.
- A leader that hangs after its win and before its record cannot be found: no record names it. That time is a few milliseconds. Node gives no way to close it, because it has no `F_GETLK`.
- A published leader writes no record and serves no pipe. A new candidate under it finds no record, so it waits its back-off and tries again, at most once a second ([ADR 0007](./0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md)). A hang of a published leader is not found.
