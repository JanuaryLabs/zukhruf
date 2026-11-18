# The reaper removes the run's host directories

Superseded in part on 2026-11-18 (#4503 U8b) by the amendment of [ADR 0024](./0024-a-run-holds-one-ssh-connection-to-an-ssh-engine-and-its-test-processes-reach-the-engine-host-through-it.md): the forward records, the `ssh` process records and their removal are gone, and the teardown and recovery remove the folder of the run's sockets.

`DockerTestbed.directory()` makes a host directory on the engine's host, for bind mounts. Before this record, a directory record in the run's directory named it (`record('directory', …)`), and the global teardown or the recovery of a later run removed it from this machine: with `rmSync` on a local engine, and with `ssh … rm -rf` on an SSH engine. Thus a killed test process left its directory until a test ran again on this machine ([ADR 0020](./0020-a-reaper-container-removes-a-runs-engine-objects-when-the-attach-that-holds-it-closes-and-recovery-keeps-the-local-records.md) item 6). Since [ADR 0022](./0022-a-reaper-starts-again-after-a-restart-of-its-engine-and-removes-itself-at-its-end.md), the run's reaper cleans its run with no later test run.

The maintainer decided on 2026-11-18 (backlog #4508): "Reaper cleans folders too". The reaper deletes the tests' host directories, and this machine keeps records only for the SSH tunnels: the forward directories in its own `/tmp` and the `ssh` processes, which the reaper cannot reach.

### The probes of 2026-11-18

The probes ran on Docker Desktop 29.9.3 for macOS (context `desktop-linux`, VirtioFS file sharing, the mount type `fakeowner`), with `alpine:latest` containers (`~/.claude/scratch/4508/p2a/probe*.log`).

- **A bind mount point cannot be removed in the container.** `rmdir` of the mount point gives `Resource busy`.
- **The root of a container acts as the user of the Mac.** A plain `rm -rf` cannot remove a folder that a container made `chmod 000` through a bind mount. After `chmod -R u+rwx`, `rm -rf` removes it.
- **A folder that the Mac made `chmod 000` cannot be reached from a container.** `ls` lists its name, but `stat`, `chmod` and `rm` give `No such file or directory`. A folder that the Mac made `chmod 555` refuses `chmod` from a container. `rmSync` of Node on the Mac also fails on both (`ENOTEMPTY`), so the directory records did not remove them either.
- **The engine refuses to start a container whose bind source is gone** (probe 7): "bind source path does not exist".

## Decision

1. **The reaper mounts the folder of the engine's host that holds the host directories** (`directoryParent` in `src/docker/run-records.ts`): `/tmp` on the host of an SSH engine, else the temporary folder of this machine (`os.tmpdir()`). The mount is at `/directories` (`reaperRequest` in `src/docker/reaper.ts`). It is a `bind` mount with `CreateMountpoint`, so the engine creates the folder when its host has none, as the host of an engine that a relay reaches does not. The run's engine objects do not wait for its directories.
2. **A host directory keeps its name and its place**: `zukhruf-testing-<run id>-<random>` in that folder (`DockerDirectory.create`). It has no record.
3. **`directory()` holds the run's reaper before it makes the directory**, as a create does (`src/docker/testbed.ts`). Thus a test process that makes only a directory also has a reaper that removes it.
4. **After its first pass, the reaper removes the run's directories**: `chmod -R u+rwx`, then `rm -rf`, of each `/directories/zukhruf-testing-<run id>-*`, each within `requestTimeout` (the shell function `directories`). The first pass removed the run's containers, which can write to a directory through a bind mount. `closingTime` adds the two calls.
5. **The global teardown and recovery remove only the SSH forward directories** (`removeRecordedPaths` in `src/scripts/run-cleanup.ts`). `RunRecords.record(kind, path)` becomes `recordForward(path)`.

The tests are in `src/docker/reaper.integration.test.ts`:

- "the reaper of a run removes the directory of its killed test process, with no later run"
- "the reaper of a run removes a directory of its killed test process that holds a folder a container made chmod 000"
- "the reaper of a run keeps the run’s directories while one of its test processes lives, and removes them after the last one ended"

## Considered Options

- **A folder for each run, `zukhruf-testing-<run id>/`, mounted into the reaper (the plan of #4508).** The reaper cannot remove its mount point, so an empty folder of each run stays. A folder that the host removes, such as `/tmp` at a restart of the host, is a missing bind source: the engine refuses the start ("bind source path does not exist", probe 7), so the engine cannot start the reaper again after the restart, and ADR 0022 fails for that run. The folder would also cost one `mkdir` on the engine's host for each run, over SSH for an SSH engine.
- **A folder for all runs, `zukhruf-testing/`, with a folder for each run in it.** A folder that the engine creates with `CreateMountpoint` belongs to `root` on a Linux host, so a test user could not make a folder in it after a restart of the host. The temporary folder of the host always exists, and the test user can write in it.
- **Keep the directory records.** A killed run's directories then wait for a later test run on this machine, which the maintainer's decision removes.

## Consequences

- A killed test process's directory goes about 2 s after the last test process of the run ended, also after a restart of the engine (ADR 0022), with no later test run.
- The reaper can read and write the temporary folder of the engine's host. It already has the engine's socket, which gives more.
- On Docker Desktop, a folder that the test process made `chmod 000` or `chmod 555` with `DockerDirectory.chmod` stays: no container can open it (see the probes). The directory records did not remove it either. On a Linux engine whose containers run as `root`, `rm -rf` removes it.
- Not tested: the SSH engine (its folder is `/tmp` of the engine's host), Docker Desktop for Windows (a bind mount of a Windows path such as `C:\Users\…\AppData\Local\Temp`), Podman and socktainer (`CreateMountpoint`, and the temporary folder of macOS in their machine), and an engine older than API 1.44, which ignores `CreateMountpoint`.
- What stays: the forward records and the `ssh` process records, the process record of a test process (`recordThisProcess`), and the engine part of recovery, until part 2 of #4508.
- This ADR supersedes in part ADR 0020: item 6 (the reaper cannot reach the temporary directories), the point of item 6 that the teardown removes each recorded path, and the consequence on a run whose processes only made a host directory.
