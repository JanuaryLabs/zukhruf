# Docker engine tokens come from a ladder of named volumes

A network lock store makes its fencing tokens on its server ([ADR 0021](./0021-a-lock-store-can-reach-every-machine-that-reaches-one-server.md)). The Docker engine has no counter. But it gives a volume name to one volume only. Thus the tokens of `DockerEngineStore` come from a **ladder**: rung `n` of a key is the volume `<namespace>-<digest>-token-<n>`. The number of the rung that a holder creates is its token.

This is the rule of the Delta Lake transaction log. Each commit writes the log file of the next version, and the storage must refuse a second file with the same version: "mutual exclusion" with put-if-absent ([Delta Lake protocol](https://github.com/delta-io/delta/blob/master/PROTOCOL.md); Armbrust et al., "Delta Lake: High-Performance ACID Table Storage over Cloud Object Stores", VLDB 2020).

To mint a token, the holder lists the rungs of the key by label, creates rung `n + 1` above the highest rung `n`, and climbs to `n + 2` on `NameConflictError`. Then it removes the rungs that it listed, so each key keeps one rung. A rung is removed only after a higher rung exists, so a list always finds the highest rung.

**The holder confirms its claim after the mint.** The mint is not part of the claim. A holder that read the ladder before it lost its claim can climb above the token of the next holder. A probe showed this: holder A read the ladder, its claim was removed, holder B got the claim and minted 1, and then A minted 2. Thus after the mint, the holder finds its claim by ID. If the claim is gone, the token goes to nobody, and the caller tries again. If the claim is there, no other holder got the key before the mint, so each later holder lists the new rung and mints a higher number.

In probes, 15 rounds of 6 `volumes.create()` with one name at the same time gave one volume in each round, on Docker Desktop 29.8.0 and on Docker 28.5.0 over SSH. 10 mints gave 1 to 10, and one rung stayed. 3 mints at the same time gave 11, 12 and 13. A mint took 3 to 9 ms on Docker Desktop and 220 to 452 ms over SSH.

## Considered Options

- **A ladder of containers in the state `created`.** A container name is also given once. But `docker container prune` removes each container that does not run, also a `created` one. In a probe, it removed one. The ladder would go back to 1 after each prune, and a fenced resource would refuse the writes of each next holder. `docker volume prune` keeps named volumes.
- **A counter in a file in a volume.** Only the holder of the key mints, so a read and a write of the file would need no other lock. But each read and write needs an exec or an archive request in a container that runs, which costs more round trips than a list and a create. A crash between the read and the write also needs a rule.
- **The time of an event of the engine.** `timeNano` of the `create` event of the claim increases in most cases. But the clock of the engine host can go back, so the tokens would not always increase.
- **A mint before the claim.** The holder would mint first, then create the claim, then check that its rung is still the highest. This also works. But a caller that waits would mint a rung for each attempt, also for each attempt that fails. A mint after the claim mints once for each grant, as `PostgresStore` does with `nextval`.
- **A mint that rejects on `NameConflictError` instead of a climb.** A stale holder that created rung `n + 1` first would then make the real holder fail. The confirmation already protects against the stale holder, so the climb is safe.

## Consequences

- A grant costs a list, a create and a removal of volumes, and an inspect for the confirmation.
- `docker volume prune -a` and `docker system prune -a --volumes` remove the ladder. The tokens then start again at 1. The docs of the store tell the operator to exclude the label `zukhruf.mutex.namespace`.
- The ladder stays when the engine restarts, because volumes are on the disk of the engine host.
- A stale holder that climbed and then failed its confirmation leaves a rung. The next mint goes above it, so tokens have gaps. Gaps are normal for fencing tokens.
- The lock-store matrix gets a test: the tokens increase after `docker container prune`.
