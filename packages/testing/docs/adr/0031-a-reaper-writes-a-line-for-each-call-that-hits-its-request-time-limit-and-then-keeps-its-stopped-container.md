# A reaper writes a line for each call that hits its request time limit, and then keeps its stopped container

The reaper runs each call to the engine within its request time limit (`once` in `src/docker/reaper.ts`, ADR 0020 item 4). A list or a drop of a shared server that does not answer within that limit counts as done (ADR 0020 item 8). Before this decision, such a call ended with no output: the four places (the list of the shared servers, the inspect of a server, the list of its databases and the drop of one) went on with `return 0`. Then the reaper removed its own container (ADR 0022 item 3), so its output went with it. An operator who found a kept test database could not tell which call the limit ended. The test of #5266 could not name the call either (backlog #5482).

Ryuk 0.14.0 writes `log/slog` text lines to its output: `Warn` for a shutdown timeout, `Error` for a failed removal, `Info` for each removal. Its output also goes away with its container, which has `AutoRemove`.

Two places outlive the reaper. The maintainer chose between them on 2026-11-24: "B: keep its container (Recommended)".

## Decision

1. **A call that the request time limit ends writes one line to the reaper's standard error, in the slog text shape of Ryuk**: `level=WARN msg="request time limit" call="<the call>" server=<id> limit=<ms> run=<run>`. `server` is only on a call to one shared server. The line names the call and does not copy it, because the command of a drop holds the credential of its server: `docker exec <id> list`, `docker exec <id> drop <database>`, `docker inspect <id>`, else the first two words of the command, such as `docker ps`. The call then fails as before, and a server whose list or drop hits the limit still counts as done (ADR 0020 item 8). A watchdog in the script (`bounded` in `src/docker/reaper.ts`) ends the call with `KILL` at the limit. It writes its mark before its kill. The call counts as one that hit the limit only when the watchdog wrote its mark and the call ended with the exit status 137 of that kill.
2. **A reaper with such a call keeps its container at its end.** It does not remove itself, so `docker logs <reaper>` keeps the lines. Before it exits, it sets the restart policy `no`, so the engine does not start it again, and it renames itself to `zukhruf-testing-reaper-<run>-<self>`, so the next reaper of the run can take the name of the run's reaper. When one of the two fails, it removes itself, as before. A reaper with no such call removes itself, as before.
3. **A hold that comes while a reaper closes waits until that reaper ended**: the engine removed it, or it stopped (`closed` in `src/docker/reaper.ts`). Then the hold holds the next reaper of the run.
4. **Each reaper removes each stopped reaper that is older than `keptTtl`**, after it removed the expired shared servers. The age is from the `Created` time, as for a shared server (ADR 0019). `keptTtl` is 7 days, the TTL of a shared server. The reaper selects them by the reaper label and the status `exited` or `dead`, and removes them with no `-f`, so the engine refuses the removal of a reaper that runs.

The tests are in `src/docker/reaper.integration.test.ts`:

- "a reaper whose list of the databases of a shared server hits its request time limit keeps those databases, keeps its stopped container with one line for each list, and a hold that comes while it closes holds the next reaper of the run"
- "a reaper whose drop of a database never gets an answer ends within its request time limit, keeps that database, removes the run’s containers, and keeps its stopped container with a line that names the drop"
- "a reaper whose list of the shared servers hits its request time limit keeps its stopped container with one line that names the list and no server"
- "a reaper removes each stopped reaper that is older than keptTtl, and keeps a younger stopped reaper, a created reaper, a reaper that runs, and a reaper that starts again before its removal"
- "a reaper whose shared server is removed while it drops the run’s database in it removes the run’s containers, writes no line of a request time limit, and ends once": a call that the removal of its container ends is not a call that hit the limit.
- "one reaper of a run keeps the run’s objects while one of its holders lives, and removes them, with their anonymous volumes, after the last one ended": a reaper with no such call removes itself.

## Considered Options

- **A log file `reaper-<run>.log` in the folder of the host directories** (ADR 0023), which the next reaper removes after the TTL. The maintainer chose the container.
- **A label on the reaper.** The engine cannot change the labels of a container that runs.
- **The whole command in the line.** The command of a drop holds the credential of its server, and `docker logs` would show it.
- **The exit status 137 alone as the mark of a limit hit.** It is not proof that the limit fired. `docker exec` (docker:28.5.2-cli) exits 137 when its container is removed or stopped during the call. A reaper whose exec was cut by the removal of its server wrote a false line and kept its container, and the tests of the reaper hung at 300 s (#5482).
- **A status that only BusyBox `timeout` gives when it fires.** BusyBox 1.37.0 `timeout` gives no such status. It execs its program in its own process, so the shell gets the status of the program: 137 with `-s KILL` or `-k`, 143 with the default TERM, and the program's own status when the program traps the signal. A program that an outside `KILL` ends, or that exits 137 itself, gives the same 137.
- **The time that the call took.** A call that ends near the limit for another reason, such as a removal of its server, would count as a limit hit. The mark of the watchdog is the fact itself.
- **The TTL of a shared server (`serverTtl`) for the stopped reapers too.** The tests give `serverTtl` 1 ms to expire their own servers, and a proxy keeps the servers of other sessions. With one TTL, each of those reapers would also remove each kept reaper on the engine, also those of other sessions and of other tests.

## Consequences

- A kept reaper stays on the engine until the first reaper that ends after its `keptTtl`. An engine that no run uses keeps its kept reapers.
- A test that waits until the run's reaper is gone fails when a call of that reaper hits its limit. Before, the limit was silent.
- The renamed reaper keeps the label of its run, so a list by that label finds it.
- `closingTime` adds the removal of one stopped reaper. The update and the rename of a reaper that keeps its container take less time than its removal.
- The mark is the fact that the limit fired, not a reading of the exit status. A call that the removal of its container ends fails as before: the reaper writes no line, and it removes itself.
- Each call starts a watchdog: one subshell and one `sleep`. The reaper stops the watchdog when the call ends, and kills its `sleep` with `KILL`. A `TERM` that comes before the `exec` of the `sleep` goes to the trap of the shell that forks it, and the `exec` drops it, so that `sleep` would run to the limit. The probes of 300 short calls in BusyBox left no `sleep`, and no `Terminated` line in the output of a call.
- When a reaper with such a call cannot verify its socket, it ends with exit 1 and a holder removes it (ADR 0020 item 14): its lines go with it.
