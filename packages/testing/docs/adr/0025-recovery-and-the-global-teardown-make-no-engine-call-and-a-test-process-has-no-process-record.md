# Recovery and the global teardown make no engine call, and a test process has no process record

Before this record, recovery had an engine half ([ADR 0020](./0020-a-reaper-container-removes-a-runs-engine-objects-when-the-attach-that-holds-it-closes-and-recovery-keeps-the-local-records.md) item 9). For a dead run with a process record, the global setup connected to the engine, asked whether the run still had a reaper or an object (`reaped`), and else started a new reaper of the run (`startReaper`). A run with no process record "never reached the engine", and recovery deleted its records with no engine call. Thus each test process wrote a process record for itself (`RunRecords.recordThisProcess`) on its first acquisition and in `defaults()` ([ADR 0013](./0013-the-docker-area-is-a-testbed-that-takes-engine-api-bodies-and-the-run-is-not-part-of-its-api.md) items 3 and 8). The global teardown kept the records of a run that had one, because it could not see whether the reaper acted (ADR 0020 item 6).

Two changes took the reasons away:

- [ADR 0022](./0022-a-reaper-starts-again-after-a-restart-of-its-engine-and-removes-itself-at-its-end.md): the reaper has the restart policy `unless-stopped` and removes itself at its end, so the engine starts it again after a restart of the engine, and it cleans its run with no later test run.
- [ADR 0023](./0023-the-reaper-removes-the-runs-host-directories.md): the reaper removes the run's host directories, and the directory records are gone.

The maintainer asked on 2026-11-17 (backlog #4508): "why do we still do this.#run?.records.recordThisProcess()? since we use the reaper we no longer depend on the machine". On 2026-11-18 he added: "you are depending on tests actually running again to heal the reaper".

## Decision

1. **A test process writes no process record for itself.** `RunRecords.recordThisProcess` is gone, and so are its two calls in `DockerTestbed` (the first acquisition and `defaults()`). Since ADR 0020, each test process that creates on the engine holds the run's reaper, and the reaper waits while a holder lives. A record of the process on this machine protects no engine object.
2. **Recovery makes no engine call.** `reaped()`, `startReaper()`, `sharedDatabases()` and the `Docker.connect` of recovery are gone, with the shortcut "a run with no process record never reached the engine". For each dead run, recovery removes the recorded SSH forward directories and then the run's records (`recover` in `src/scripts/docker-global-setup.ts`).
3. **The global teardown deletes the run's records.** It removes the recorded SSH forward directories, and then the run's directory. It no longer reads the process records.
4. **What this machine keeps.** The reaper cannot reach this machine, so these stay, each with its reader:
   - the forward records (`recordForward`): `removeRecordedPaths` in the global teardown and in recovery removes the forward directories that they name;
   - the process records of the `ssh` commands of a test process (`recordProcess`, with a random id for a reused pid): recovery leaves a dead run alone while one of them lives, because that command can still use a forward directory of the run;
   - `run.json` with the runner's pid and the engine's endpoint: recovery leaves the run of a live runner alone, and recovers only the runs of its own engine;
   - the claim of a dead run by a rename (`recovering-<pid>-<uuid>`): two runners that start together do not remove the same forward directory, and a runner leaves a run that a live runner claimed.

The tests are in `src/scripts/docker-global-setup.integration.test.ts`:

- "the recovery of a dead run that used Docker makes no engine call, and deletes its records"
- "recovery leaves a dead run alone while a live runner holds its claim"
- "recovery keeps a dead run while a command lives whose pid an ended command of the run had"
- "a run whose tests never touch Docker leaves no record and makes no daemon call"

## Considered Options

- **Keep the engine half as a backstop.** Its only cases are the gaps below. Each one costs an engine call at each global setup after a run that used Docker, and depends on a later test run on the same machine and engine, which the maintainer ruled out for the restart of the engine (ADR 0022).
- **A marker of "the run reached the engine", written at the run's first hold of the reaper.** It replaced the process record only for the shortcut of recovery. With no engine half, nothing reads it.
- **A process record for each test process, with no engine half.** A live test process of a dead runner would still keep its run's records. A test process uses the run's directory only for the forward records, and an `ssh` command record already keeps the run while a forward is in use.

## Consequences

- The global setup and the global teardown make no engine call, also after a run that used Docker. The global teardown leaves no record of a run that ended.
- A test process of a killed runner that still lives no longer keeps its run's records. Its engine objects stay while it lives, because it holds the reaper. Recovery can remove the run's directory while the process lives and holds no `ssh` command. A forward that the process opens after that fails to write its record (`ENOENT`) and removes its own forward directory. The runner is dead, so no one reads the result of that test.
- Known gaps, not solved:
  - A reaper whose socket check failed exits with no restart policy and now stays `exited` (ADR 0022). Nothing removes it, because recovery is gone. It carries its labels (`dev.zukhruf.testing.reaper=<run id>`), so it can be pruned by label. A holder of the same run removes it, as before.
  - A reaper container that someone removes by hand before it acted leaves its run's objects. They carry the run's label, so they can be pruned by label.
- What stays: the forward records, the `ssh` process records and the parts of recovery that read them, until ADR 0024 removes them.
- This ADR supersedes in part:
  - ADR 0013: in item 3, "It writes a process record for this process"; in item 8, "That call records its process, so the global teardown keeps the run's records while the process lives"; and the reason of the option "A public `recordProcess(pid)`" ("A child process that reads `defaults` records itself").
  - ADR 0020: item 6 (what the teardown keeps), item 9 (the recovery of engine objects through `startReaper`, and when recovery deletes the records), the point of item 13 that recovery starts a `created` reaper, the point of item 5 that recovery still connects, and the point of item 11 that a run whose processes held no reaper keeps its records.
  - [ADR 0006](./0006-a-killed-run-is-cleaned-by-nodes-global-setup-and-teardown.md) and [ADR 0011](./0011-the-run-id-in-a-databases-name-is-its-owner-reference-and-one-collector-for-each-kind-drops-a-dead-runs-databases.md): their points that a test process records itself.
  - ADR 0022 and ADR 0023: their points "What stays" about the engine part of recovery and the process record of a test process.
