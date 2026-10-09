# Leader election is a package, and each backend is a subclass of one campaign

The socket lock store of `@zukhruf/mutex` and `@zukhruf/single-flight` each had a copy of the same leader election. The copies were the same except for their file names. The mutex also published its copy as the entry point `@zukhruf/mutex/leader-election` ([mutex ADR 0002](../../../mutex/docs/adr/0002-election-is-not-part-of-the-mutex.md)). Thus the election moved into this package, and both packages use it. The election had to be open to other backends too, so that an election across hosts is only a new subclass. Thus `LeaderElection` is an abstract class with the Template Method pattern: the base runs the campaign and owns the term, and a backend implements five steps for its claim. `SqliteElection` is the first backend. A term of a lease can end while its leader still runs, so the term has a signal that aborts on a loss.

## Considered Options

- **Keep the two copies until a third package needs the code.** This is the Rule of Three, and [single-flight ADR 0006](../../../single-flight/docs/adr/0006-the-election-and-the-connection-are-a-copy-of-the-mutex-code.md) selected it. The maintainer extracted the election at the second copy, because its boundary was already clear: the claim, the term, the epoch and the campaign. The connection to the leader stays a copy in each package (backlog #2496).
- **An interface for backends, with a separate campaign.** Each backend would repeat the campaign: the tries, the deadline, the abort, and the cleanup after a failure. Those rules are the same for each backend, so they belong to one base class.
- **One abstract class with the campaign, and abstract steps.** The repository already uses this pattern for its file lock stores (`FileLockStore`). [Apache Curator](https://curator.apache.org/) and [client-go](https://pkg.go.dev/k8s.io/client-go/tools/leaderelection) also keep the election in one place and put the backend behind a narrow interface. This option was selected.

## Consequences

- `@zukhruf/mutex/leader-election` is gone, and `Leadership` is now `Term`.
- A backend keeps four rules ([README](../../README.md#write-a-backend)). The base cannot enforce the timing rule for a lease: `lose` must come before the backend can give the claim to another candidate.
- A leader that acts for its group stops when `term.signal` aborts. The servers of the socket lock store and of a single flight do this, although `SqliteElection` never loses a living term.
- Those two servers meet their candidates over a socket in the directory, so they work on one host only, whatever the backend.
