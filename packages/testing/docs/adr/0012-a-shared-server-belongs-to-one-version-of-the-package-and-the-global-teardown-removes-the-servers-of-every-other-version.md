# A shared server belongs to one version of the package, and the global teardown removes the servers of every other version

`reuse()` gives one shared server for each configuration on an engine. The name of the server is `zukhruf-testing-<fingerprint>`. The hash in `reuse()` in `src/docker/testbed.ts` takes the whole configuration: the Engine API body after the testbed adds its defaults (the image, the command, the environment, the labels, the resources), the `internalPort` and the number `transportVersion`. Shared servers outlive runs on purpose (ADR 0006). They exist for speed: in deepagents 528cafa7, the SQL Server tests went from 813 s to 30 s. Thus a removal after each run is not an option.

A change of the configuration gives a new fingerprint, thus a new name and a new server. Nothing removes the old server. The README told the user to stop it with `docker stop`. Each change in `@zukhruf/testing` left one full set of servers on each engine:

- `transportVersion` went from 2 to 3 on 2026-10-21 (7efc974).
- ADR 0011 added the kind label to each database server on 2026-10-26 (#2842).

On 2026-10-26, Docker Desktop ran 13 shared servers. They used about 3.6 GB of memory. The present code used 4 of them (backlog #3072).

Testcontainers has the same design for its reusable containers: a hash of the configuration in a label selects the container, and Ryuk does not remove a reusable container. The user stops it.

## Decision

A shared server belongs to one version of `@zukhruf/testing`.

1. `reuse()` adds the label `dev.zukhruf.testing.version` to each shared server. Its value is the version of the package, for example `0.3.42`.
2. The hash in `reuse()` takes the version. Thus each release gives each configuration a new name. `transportVersion` is deleted: the version does its work. A change in what `reuse()` creates gives new servers at the next release, and nobody must remember to change a number.
3. The global teardown removes the shared servers of other versions. It does this only for a run that used Docker: a run that has a process record or a creating record. This is the same condition that starts the cleanup of the run (ADR 0006). The worker of the teardown cleans the run first. Then it lists the shared servers on the engine of the run. It selects them with the label `dev.zukhruf.testing.shared=1`. It removes (with force) each server whose version label is not exactly the version of this package. (Superseded in part by [ADR 0014](./0014-a-test-process-holds-a-process-lease-and-the-global-teardown-keeps-the-shared-servers-of-a-version-that-has-one.md): it keeps the servers of a version that has a process lease.) It also removes a server that has no version label. It never removes a server of this version.

The rule is the same on a local engine and on an SSH engine.

## No design for older versions

Superseded by [ADR 0014](./0014-a-test-process-holds-a-process-lease-and-the-global-teardown-keeps-the-shared-servers-of-a-version-that-has-one.md). The skew is not zero: after each release, the consumers lock different releases for some time.

A run on an older version of the package can use a server that this rule removes. That run breaks. This is accepted: each consumer moves to the latest release of `@zukhruf/testing`. Kubernetes calls the versions that one release supports together its version skew policy. The skew that this package supports is zero.

Thus the rule has no wait for the runs that are alive, no index of the last use, no age limit and no limit to a local engine. Each of these exists only to protect an older version, so none is added.

## Considered Options

- **Keep the manual stop** (the design until now, ADR 0006 and ADR 0011). The servers accumulate: about 3.6 GB on 2026-10-26.
- **Remove a server that no run used for N days**, with an index of the last use that `reuse()` writes. The index is bookkeeping that exists only for older versions.
- **Keep `transportVersion` as the number that a person increases** when `reuse()` creates a different server. A person must see that a change needs it. #2842 changed the servers through a label and did not change the number. The number changed only once, from 2 to 3, and the servers of 2 stayed.
- **Remove the servers in the global setup, at the start of each run** (the first text of this ADR). Then no test of the run uses a server of another version. But the global setup calls the engine at the start of each run, also for a run that has no Docker test. That run then fails when the engine does not answer. The tests of this version never use a server of another version, because the version is part of the name. Thus the removal can wait until the teardown.
- **Remove a server only when no other run is alive.** (Superseded in part by [ADR 0014](./0014-a-test-process-holds-a-process-lease-and-the-global-teardown-keeps-the-shared-servers-of-a-version-that-has-one.md): the teardown keeps the servers of a version while a test process of that version holds a process lease.) A run of this version needs no protection, because this version keeps its servers. Thus the condition protects only the runs of older versions.

## Consequences

- Each release starts each shared server one time on each engine. A Postgres server starts in about 2 s on a local engine. A SQL Server server starts in about 30 s.
- Two projects on different versions that use one engine remove the servers of each other at the end of each run that used Docker. This continues until both use the latest release. (Superseded by [ADR 0014](./0014-a-test-process-holds-a-process-lease-and-the-global-teardown-keeps-the-shared-servers-of-a-version-that-has-one.md): a teardown keeps the servers of a version while a test process of that version runs.)
- A run without Docker never calls the engine. The global setup calls the engine only when a dead run on that engine has records to sweep (ADR 0006). The global teardown calls it only for a run that used Docker.
- The servers of other versions stay on the engine until the end of the first run that used Docker on that engine.
- The global teardown fails when the removal of a shared server fails. It prints the error, keeps the run's records and sets exit code 1, as for each cleanup failure (ADR 0006).
- The rule does not cover a consumer that changes its own body in one version, for example the tag of its image. The old server stays. The README keeps the `docker stop` procedure for this case.
- In this repository, the version changes only at a release. A change to what `reuse()` creates before that release gets the servers of the last release. Stop them with `docker stop` to test the change.
- The rule does not cover a project that runs `reuse()` without the global setup. No global setup runs, so nothing removes its old servers.
- The code step adds these tests, in the shape of `src/scripts/docker-global-setup.integration.test.ts`:
  - "a shared server of another @zukhruf/testing version is removed when a run that used Docker ends"
  - "a shared server of this version is kept"
  - "a shared server with no version label is removed"
  - "a run that never used Docker leaves other versions' servers alone"
