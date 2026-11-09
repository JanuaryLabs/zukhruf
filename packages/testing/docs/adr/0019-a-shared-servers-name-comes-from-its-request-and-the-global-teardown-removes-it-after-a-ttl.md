# A shared server's name comes from its request, and the global teardown removes it after a TTL

Accepted on 2026-11-09 (user, #3415). The code is not written yet. Until it is, ADR 0012 and ADR 0014 describe the code.

ADR 0012 puts the version of this package in the name of a shared server, and the global teardown removes the shared servers of other versions. Each release of this package thus retires each shared server. In the last 30 releases, 5 changed the source of this package, and 30 retired the servers. Repositories on different versions also remove the servers of each other between their runs. On 2026-11-09, one machine had four locked versions: 0.8.7, 0.8.10, 0.8.11 and 0.8.12. ADR 0014 prevents a removal during a run, but the next run of the other repository starts cold.

The version is not necessary for a safe reuse. The request defines the server. The two changes that ADR 0012 gives as its reason are both in the request: the port binding of `transportVersion` 3 (7efc974) and the kind label (ADR 0011). The hash does not see the port binding today, because `reuse()` adds it after the hash.

The version has one other job: it tells which servers to remove. A time to live (TTL) does this job without the version. A server of a request that nobody sends again is removed when its TTL ends.

## Decision

1. The name of a shared server is `zukhruf-testing-<fingerprint>`. The fingerprint is a hash of the final request and the internal port. The final request includes the defaults of the testbed and the published port. The version is not in the hash.
2. One label, `dev.zukhruf.testing.server=<fingerprint>`, marks a shared server. It replaces `dev.zukhruf.testing.shared`, `dev.zukhruf.testing.config` and `dev.zukhruf.testing.version`.
3. `reuse()` takes one process lease for each server, on the fingerprint of that server. One process has one lease for each server that it uses on an engine.
4. A test process takes its lease, and then waits until the sweep lease of that fingerprint is gone. The order of ADR 0014 stays. Only the key changes, from the version to the fingerprint.
5. The global teardown of a run that used Docker lists the shared servers. For each server whose `Created` time is older than the TTL:
   1. It takes the sweep lease of the fingerprint.
   2. It looks for process leases of the fingerprint.
   3. When it finds none, it removes the server with force, and with its anonymous volumes. When it finds one, it keeps the server.
   4. It removes the sweep lease.
6. The TTL is 7 days. It is a constant, not an option.
7. This package reads the time from the clock that it gets, not from `Date`.

## Why the new label

The teardown of an older version removes each server that has `dev.zukhruf.testing.shared=1` and no version label, also during a run. A new server with that label would fail the tests of a repository on the new version, until each repository moves. With the new label, an older version does not see a new server. This needs no code for older versions.

## Why one lease for each server

One lease for an engine would keep each server while any test process runs on that engine. On a machine with many sessions, a teardown might never find an engine with no lease. A lease for each server keeps only the servers that a process uses.

## Why no design for databases in a shared server

Two versions can now use one server. ADR 0011 stays correct: a run's cleanup drops only the names that match `^test_<run id>_[0-9a-f]{16}$` with its own run id, so one version never drops a database of another version. A change to what a server must be, such as an image or a kind label, changes the request, and thus the name.

When a later version changes that name pattern, its recovery misses the databases that an earlier killed run left. They stay until the TTL removes the server.

## Considered Options

- **Keep ADR 0012 and ADR 0014.** Each release restarts each server, and repositories remove the servers of each other.
- **A hash of the code of this package in place of the version.** It retires servers in 5 of the last 30 releases, not 30: `dist` of 0.8.11, 0.8.12 and 0.8.13 has the same hash. But an edit that does not touch a server also restarts each server, and the code must read each file of the package. The hash also differs between `src` and `dist`.
- **An idle TTL, from the last use.** Docker has no time of last use, so `reuse()` must write an index. ADR 0014 rejected this index as bookkeeping.
- **Remove a server when its last process lease ends.** Then each run starts cold. Shared servers exist for speed: in deepagents 528cafa7, the SQL Server tests went from 813 s to 30 s (ADR 0012).
- **A server that exits by itself after the TTL.** This is the only rule that also works when no run uses the engine. But the body is the caller's image and command, so the testbed must wrap them or add a helper container.
- **`POST /containers/prune` with an `until` filter.** It removes only stopped containers.
- **One lease for the whole engine.** See "Why one lease for each server".

## Consequences

- Repositories that send the same request share one server, whatever version they have.
- A server restarts about once for each TTL, or when its request changes. A SQL Server server starts in about 30 s.
- The check runs only at the end of a run that used Docker. An engine that no run uses keeps its servers.
- A server in constant use stays until a teardown finds no lease on it.
- A server lives longer than today. A database whose drop failed can stay up to the TTL. An empty Postgres database uses about 7.75 MB of the 512 MB tmpfs (ADR 0011), so about 59 of them fill the server, and then each `database()` on that server fails until the server is removed. Backlog #3079 relied on the old rule as the bound. The bound is now the TTL.
- A body that a consumer changes no longer needs a `docker stop`: the old server goes when its TTL ends. A newer image behind the same tag still needs a `docker stop`, or the end of the TTL.
- Older versions do not see the new servers, and this version does not see the old ones. After the last repository moves, stop the old servers one time on each engine:

  ```sh
  docker ps -a --filter label=dev.zukhruf.testing.shared=1
  docker stop <container-id>
  ```

- The code step changes the tests in `src/scripts/docker-global-setup.integration.test.ts`, and adds these:
  - "two processes that send the same request get one server, whatever their version"
  - "a server older than the TTL with no process lease is removed when a run that used Docker ends"
  - "a server younger than the TTL is kept"
  - "a server older than the TTL with a live process lease is kept"
  - "a server older than the TTL whose holder was killed is removed"
  - "a process waits for the sweep lease of its server, and the sweep keeps a server whose process looks for that lease"
