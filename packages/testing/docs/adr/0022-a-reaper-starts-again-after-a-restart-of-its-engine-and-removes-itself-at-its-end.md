# A reaper starts again after a restart of its engine and removes itself at its end

Superseded in part on 2026-11-24 (#5482) for item 3. A reaper with a call that hit its request time limit does not remove itself: it sets the restart policy `no`, renames itself and exits, and a later reaper removes it after 7 days ([ADR 0031](./0031-a-reaper-writes-a-line-for-each-call-that-hits-its-request-time-limit-and-then-keeps-its-stopped-container.md)).

[ADR 0020](./0020-a-reaper-container-removes-a-runs-engine-objects-when-the-attach-that-holds-it-closes-and-recovery-keeps-the-local-records.md) gave the reaper `AutoRemove` (item 1). A restart of the engine, for example a restart of Docker Desktop, stops each container. A reaper with no restart policy stays stopped. Its run then leaks until a later test run's recovery starts a new reaper of that run (ADR 0020 item 9). When no test runs again, the run's objects stay.

The maintainer asked about that backstop on 2026-11-18 (backlog #4508): "what happens if tests never ran again? you are depending on tests actually running again to heal the reaper". The direction was a restart policy, so that Docker starts the reaper again after a restart of the engine. He said: "yes, probe the real reaper with a restart policy". After the probe, he decided to implement the reaper part first, and to remove the recovery of the global setup in a second commit (#4508).

Docker refuses a restart policy on a container with `AutoRemove` ([Start containers automatically](https://docs.docker.com/engine/containers/start-containers-automatically/); the comment at the self-removal in `src/docker/reaper.ts`).

### The probe of 2026-11-18

The probe ran the real reaper on Docker 28.5.2 in a `docker:28.5.2-dind` engine (`~/.claude/scratch/4508/probe-restart/`, with the results on #4508).

- **The policy alone is unsafe.** With `unless-stopped` and self-removal only, a restarted reaper removed a live holder's container and volume in 4 of 4 runs: 1 restart of the engine, and 3 kills of the reaper's process with `SIGKILL`. There were three causes:
  1. A restarted container keeps its filesystem. The mark of a first holder (`/tmp/came`, ADR 0020 item 9) stayed, so the reaper did not wait for a first holder.
  2. `ReaperHold` dropped a failed hold that it took again while the engine was away (`#watch`).
  3. `running()` took the state `restarting` for a reaper that is closing.
- **With the four fixes below, the reaper was safe in every case.**
  - A restart of the engine while a holder lived: the holder held the reaper again 0.7 s after its start, and the objects stayed.
  - 4 kills of the reaper's process: the holder held it again in 0.3 s to 0.4 s.
  - `docker kill` and `docker stop`: the engine did not start the reaper again, because a stop by hand ends `unless-stopped`. The holder made a new reaper.
  - A socket that does not reach the engine: the reaper exited with code 1 and did not start again, because the policy comes only after the check.
  - A restart of the engine after the holder died: the engine started the reaper again, and it removed the run's objects in 68.4 s with no test run. That is the wait for a first holder (60 s) and the grace (2 s), and its passes.

## Decision

1. **The reaper has no `AutoRemove`.** It is created with no restart policy (`HostConfig` in `src/docker/reaper.ts`).
2. **After its socket is verified, the reaper gives itself the restart policy `unless-stopped`** (`docker update --restart unless-stopped`). Thus the engine starts it again after a restart of the engine or a kill of its process. A failed `docker update` is ignored. The reaper then runs with no policy, as before.
3. **At its end, the reaper removes its own container** (`docker rm -f`), with its door still closed. When that removal fails, the engine starts the reaper again after the exit, and it does its passes again.
4. **At its start, the reaper deletes its old mark of a first holder and its old result of the socket check** (`CAME` and `BIND`). A restarted container keeps the files of its last start. An old mark would end the wait for a first holder at once. An old check would answer a holder before this start checked the socket.
5. **A holder takes a lost hold again each `interval` until it holds** (`ReaperHold`, `#watch`). The engine can be away, as at its restart. Each try has the readiness bound of a hold (ADR 0020 item 15), and the tries go on while the process lives. Their timers keep no process running. A `held()` in the meantime joins the hold that runs, and rejects with its failure.
6. **`running()` waits while the reaper is `restarting`**, one `interval` apart, until the reaper runs. A reaper that the engine starts again is not closing.
7. **`closingTime` adds one removal**, for the removal of the reaper itself.

The tests are in `src/docker/reaper.integration.test.ts`:

- "a holder holds the reaper of its run again after a restart of the engine, and that reaper keeps the run’s objects"
- "a holder holds the reaper of its run again after a kill of the reaper’s process, and that reaper keeps the run’s objects"
- "a reaper that the engine starts again after its restart waits for a first holder, so a holder that comes back late finds the run’s objects"
- "a reaper whose engine restarts after its last holder was killed starts again by itself, and removes the run’s objects and itself with no test process"
- "a reaper whose socket does not reach its engine exits 1, and the engine does not start it again"

## Considered Options

- **The policy alone, with no other fix.** A restarted reaper removed a live holder's objects in 4 of 4 runs of the probe.
- **The policy at the create.** A reaper whose socket check fails ends with `exit 1`. With a policy from the create, the engine would start it again after each exit, in a loop. The policy comes only after the check.
- **Keep `AutoRemove`.** Docker refuses a restart policy on such a container, so a reaper that a restart of the engine stopped stays stopped, and its run waits for a later test run's recovery.

## Consequences

- After a restart of the engine, Docker starts the reaper again. With no holder, it waits for a first holder and the grace, removes the run's objects, and removes itself. No later test run is necessary.
- Cleaning after a restart of the engine with no holder takes the wait for a first holder plus the grace and the passes (68.4 s in the probe, with the defaults), not about 2 s.
- A reaper ends with exit code 137, because its own removal kills it. Thus the tests check that a reaper ended once: the engine events `start`, `die` and `destroy`.
- On Podman and socktainer, the policy and the self-removal are not tested. When `docker update` fails there, the reaper runs with no policy, as before.
- A reaper whose socket check fails exits with no policy. It now stays `exited` until a holder or recovery removes it, because `AutoRemove` is gone.
- What stays: the recovery of the global setup stays until a later commit removes it, with the process records (#4508, part 2). It is still the backstop for a reaper that was stopped by hand or whose `docker update` failed.
- This ADR supersedes in part ADR 0020: item 1 (`AutoRemove`), the last point of item 7 (a reaper that ended and stayed), item 9 (recovery as the only backstop for a reaper that a restart of the engine killed), the reason in item 13 (`AutoRemove` never removes a `created` reaper), and the end of item 14 (a reaper whose check failed).
