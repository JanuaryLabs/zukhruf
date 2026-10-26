# A Docker engine token is the higher of the engine time and the ladder

The fencing tokens of `DockerEngineStore` come from a ladder of named volumes ([ADR 0027](./0027-docker-engine-tokens-come-from-a-ladder-of-named-volumes.md)). A holder creates the rung above the highest rung, and the number of that rung is its token. The ladder is on the engine, so the engine can lose it. These actions remove it:

- `docker volume prune -a`.
- `docker system prune -a --volumes`.
- A wipe of the engine. On 2026-10-23, the disk image of a Docker Desktop engine was deleted.
- A cleanup that removes the volumes with the labels of the caller ([ADR 0029](./0029-a-docker-engine-store-marks-its-claims-and-rungs-with-the-labels-of-the-caller.md)).

**A lost ladder is a failure of safety, not only of availability.** A fenced resource refuses only a token that is lower than the highest token it has seen (see the glossary of [`@zukhruf/fencing`](../../../fencing/CONTEXT.md)). It accepts an equal token, because one holder can write two times with one token. An example:

1. Holder A gets token 57 and writes. The fenced resource keeps 57.
2. A freezes, and its claim ends. A is now a stale holder.
3. Somebody runs `docker volume prune -a`. The ladder is gone.
4. Holder B gets token 1. The resource refuses the writes of B.
5. A runs again and writes with token 57. The resource accepts the write.

The Consequences of ADR 0027 tell only about step 4. Step 5 is the failure that fencing tokens must prevent.

**The rule.** The token is the higher of two numbers:

- The `Created` time of the claim of the holder, in microseconds since 1970.
- The highest rung + 1.

To mint a token, the holder sends two requests at the same time: an inspect of its claim, and the list of the ladder. Thus the mint has no added round trip. Then the holder creates the rung with that number. If the create rejects with `NameConflictError`, the holder climbs by 1. Then it removes the rungs that it listed, and it confirms its claim. The climb, the removal and the confirmation are the same as in ADR 0027. If the inspect finds the claim gone, the mint stops, and the caller tries again. This is the same step as for a failed confirmation.

**Why the `Created` time of the claim.** The engine sets this time when it creates the claim. Thus each client of one engine reads one clock, locally and over SSH. The time has a precision of nanoseconds: a probe on 2026-10-26 gave `2026-10-26T08:29:51.153575045Z`. The `CreatedAt` time of a volume has a precision of seconds only: a probe gave `2026-10-23T10:59:50Z`. The claims of one key are in a sequence, because only one claim at a time can have the name. Thus a later claim has a later `Created` time while the clock of the engine goes forward.

Note for the code: the engine writes the time in the RFC 3339 format of Go with nanoseconds. That format removes the zeros at the end of the fraction. Thus the fraction has 0 to 9 digits. `Date.parse` keeps milliseconds only, so the code must read the fraction itself.

**Why microseconds.** A time in microseconds since 1970 is approximately 2^51 (2^50.7 on 2026-10-26). That number fits a signed 64-bit integer, as the tokens of `@zukhruf/fencing` must. It is also a safe integer in JavaScript until the year 2255. A time in nanoseconds is approximately 2^61, and it is not a safe integer in JavaScript.

**A token is not a time.** The glossary of `@zukhruf/fencing` says this, and the rule keeps it true. The token is the number of a rung. The engine time is only the lowest number that a mint can give. The ladder alone keeps the tokens in order while the ladder is there.

**What the rule gives.**

| Case                                                                                       | The token                                                      | Higher than each earlier token?                                                                                                                                                  |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A normal grant                                                                             | The engine time                                                | Yes. The claim is later than each earlier claim, and the highest rung is lower than that time.                                                                                   |
| The clock of the engine went back, and the ladder is there                                 | The highest rung + 1                                           | Yes. The highest rung is the last token.                                                                                                                                         |
| The ladder is removed                                                                      | The engine time                                                | Yes, while the clock of the engine is ahead of the highest earlier token. That is always true if the clock never went back: each earlier token was the time of an earlier claim. |
| The ladder is removed, and the clock of the engine is behind the highest earlier token now | The engine time, which can be lower than the highest old token | No. This needs two faults at the same time: a clock that went back, and a ladder that somebody removed.                                                                          |

Each case in which the ladder of ADR 0027 works still works.

**Precedent.** This is a hybrid logical clock (Kulkarni, Demirbas, Madappa, Avva and Leone, "Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases", OPODIS 2014). A hybrid logical clock gives the higher of the physical time and the last value + 1. Thus it stays near the physical time, and it never goes back. CockroachDB and the cluster time of MongoDB use hybrid logical clocks. The paper keeps the physical part and the logical part as a pair. This rule puts the logical part in the low microseconds, so the token is one integer, not a pair.

The rule has the shape of the `zxid` of ZooKeeper and of `EpochTokenSource` of `@zukhruf/fencing`: a logical part that increases with each grant, and a part that only goes forward, for when the state of the logical part is lost. In ZooKeeper, that part is the epoch of the leader. Here, it is the time of the engine.

## Considered Options

- **Keep the ladder, and tell the operator not to prune.** The docs of 0.3.41 tell the operator to exclude the label `zukhruf.mutex.namespace` from prunes. But prunes are a usual cleanup, and an engine wipe removes all volumes. A rule that each operator must remember does not keep the safety of a fenced resource.
- **The engine time only.** The reason of ADR 0027 stays true: the clock of the engine host can go back, and then the tokens do not always increase. The ladder covers that case.
- **A container that runs and mounts the ladder.** A prune does not remove a volume that a container uses. But this protects only from prunes. It does not protect from an engine wipe or from `docker volume rm`. It also adds a container that runs for each namespace.
- **An epoch from the engine clock in seconds, with the rung number in the low bits, as `EpochTokenSource` does.** Two ladders that start in one second give the same tokens. To prevent this, each new ladder must wait for up to 1 second. Also, the seconds since 1970 pass 2^31 in 2038, and `EpochTokenSource` accepts an epoch up to 2^31 − 1 only.
- **The `CreatedAt` time of a volume.** It has a precision of seconds only, so two grants in one second can get one time.

## Consequences

- Each grant has one more inspect. The store sends it at the same time as the list, so a grant has no added round trip.
- Tokens are large numbers, approximately 1.8 × 10^15 in 2026.
- The names of the rungs are 15 characters longer. The engine accepted a name of 90 characters in a probe. The local volume driver keeps each volume in a directory with the name of the volume, so a name must stay below the limit of a file name, 255 bytes on most file systems. This limit was not probed.
- An upgrade from 0.3.41 keeps the tokens in order. The times are much higher than the old rung numbers.
- A 0.3.41 client and a new client on one namespace still give tokens that increase. The old client creates the highest rung + 1. Only the old client restarts at 1 after a lost ladder.
- The operator rule "exclude the label `zukhruf.mutex.namespace` from prunes" goes away.
- The code step adds two tests:
  - "The tokens increase after the ladder volumes are removed."
  - "A rung above the engine time still gives a higher token." The test creates a rung far above the current time before the grant. This uses the same branch as a clock that went back.
