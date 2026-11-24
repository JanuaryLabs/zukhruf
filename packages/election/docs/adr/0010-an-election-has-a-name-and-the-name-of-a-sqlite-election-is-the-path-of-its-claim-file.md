# An election has a name, and the name of a SQLite election is the path of its claim file

Status: Accepted 2026-11-24 (backlog #5478). Ezz chose "Approve".

A process warning of a package names its subject ([root ADR 0010](../../../../docs/adr/0010-a-package-warning-names-its-type-code-and-subject-and-keeps-the-failure-as-its-cause.md)). Two warnings could not name the election:

- `LeaderSelector` of `@zukhruf/mutex` writes the detail `key: <name>` over a key of the mutex. Over a `LeaderElection`, it could write only the class of the election: `election: SqliteElection`. `SqliteElection` kept its directory and its claim file in private fields, and `LeaderElection` had no public identity.
- The `TermWarning` of a lost term wrote only `epoch: <n>`. Two elections on one host can both be at epoch 5, so the warning did not tell which election lost the term. This warning is of the package itself, so the package needs the identity also when no host uses it.

The leading systems give the object of a lock or an election a name, and the name is the identity of the object in its backend (read from source at the release tags):

- Hazelcast: `DistributedObject.getName()`, "the unique name for this object" (v5.7.0).
- Redisson: `RObject.getName()` (4.8.0). The name is also the Redis key of the object.
- client-go: `LeaderElectionConfig.Name`, "the name of the resource lock for debugging" (v0.37.1).
- Spring Integration: `Candidate.getRole()` (v7.2.0). The role is the key of the lock (`buildLeaderPath`).
- `@zukhruf/mutex`: `Key.name`.

etcd is not a precedent. `Election.Key()` returns the leader key of this candidate (the prefix and the lease ID), not the key of the election (`client/v3/concurrency/election.go:247-248`, v3.7.4). The prefix of the election is private, and it has no getter.

## Decision

`LeaderElection` has a public `readonly name: string`: the identity of the election in its backend. Two elections with the same name are the same election. Each backend gives the name to the base constructor, which is now `protected constructor(name: string, clock: Clock)`.

The name of a `SqliteElection` is the path of its claim file, `join(directory, claimFile)`. The backend derives it from its options. It is not an option, so it cannot disagree with the claim. Redisson does the same: the name is the key.

The two warnings name the election by its name:

| Warning                 | Detail                                    |
| ----------------------- | ----------------------------------------- |
| `LeaderSelectorWarning` | `election: <name>`                        |
| `TermWarning`           | `election: <name>`, then `epoch: <epoch>` |

The two lines of the `TermWarning` detail have a newline between them, as the detail of `DockerEngineStoreWarning` has (`key: <key>` and `container: <id>`, `packages/mutex/src/lock-stores/docker/docker-engine-store.ts`).

The election gives its name to each `Term` that it builds, in the first argument of the constructor of `Term`: `{ epoch, afterCleanShutdown, election }`. `Term` keeps it in a private field. `Term` gets no public member: a term is a lease on leadership, and the leaders give the name to the object of the lock or the election, not to the lease that a holder gets.

## Considered Options

- **The name is an option of `SqliteElection`.** The caller could give a name that is not the claim. Then two elections with different names could hold one claim, and a warning would name the wrong one.
- **`LeaderSelector` writes the class of the election.** This was the behaviour before. Two elections of one class have the same detail.
- **A key of the election, as etcd's `Election.Key()`.** etcd's `Key()` is the key of one candidate. It changes with each lease, so it does not tell which election.
- **`Term` gets a public `election`.** No leader gives the name to the lease of a holder. A host that has the term also has the election.
- **A public name on `LeaderElection`, derived by each backend from its claim.** This option was selected.

## Consequences

- A backend calls `super(name, clock)`. `MapElection` of the README and `ScriptedElection` of the tests give a name. The constructor of `LeaderElection` no longer takes only the clock ([ADR 0008](./0008-the-backend-owns-the-wait-between-two-tries-and-poll-leaves-the-campaign.md)).
- The constructor of `Term` takes `election` in its first argument. Only `LeaderElection` builds a term.
- A `'warning'` listener can tell two elections apart, also when both are at the same epoch.
- The name of a `SqliteElection` is a path on the host. A warning that goes to a log service carries that path.
