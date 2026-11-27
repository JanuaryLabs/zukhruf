# A reaper stops with SIGKILL, the signal that already ended it at each stop

The command of the reaper is `sh -c <script>` (`reaperRequest` in `src/docker/reaper.ts`), so `sh` is PID 1 of its container. The kernel gives a signal to PID 1 only when PID 1 has a handler for it, except SIGKILL and SIGSTOP ([pid_namespaces(7)](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)). The script has no trap for SIGTERM. A stop through the engine (`docker stop`, or the stop of the engine at a restart of Docker Desktop or of dockerd) sends SIGTERM, the reaper does not end, and the engine sends SIGKILL after the stop timeout of the container: 10 s by default. moby v28.5.2 stops each container with its own `StopSignal` and `StopTimeout` (`daemon/stop.go`, `container/container.go` l.584-602), also at the stop of the engine (`daemon/daemon.go` l.1222-1234). It stops the containers in parallel, so one reaper makes the whole stop of the engine take 10 s more.

Measured on 2026-11-27 (backlog #5975):

- The test "a holder holds the reaper of its run again after a restart of the engine, and that reaper keeps the run’s objects", in a `docker:28.5.2-dind` engine on devbox: dockerd logged "Processing signal 'terminated'", and 10.0 s later "Container failed to exit within 10s of signal 15 - using the force" for the reaper and the test's `sleep` container.
- `docker stop` of a `docker:28.5.2-cli` container whose command is `sh -c 'while :; do sleep 0.05; done'`, on devbox: 10.54 s and exit code 137 with the default stop signal; 0.45 s and exit code 137 with `--stop-signal SIGKILL`.

A start after a kill is safe at each point of the reaper ([ADR 0022](./0022-a-reaper-starts-again-after-a-restart-of-its-engine-and-removes-itself-at-its-end.md)): its probe killed the reaper's process with SIGKILL 4 times, and the test "a holder holds the reaper of its run again after a kill of the reaper’s process, and that reaper keeps the run’s objects" does it each run.

## Decision

The container of the reaper has the stop signal SIGKILL (`StopSignal: 'SIGKILL'` in `reaperRequest`). A stop through the engine ends the reaper at once, with exit code 137 and the state that the SIGKILL after 10 s gave before. The restart policy works as before: `unless-stopped` starts the reaper again after a stop of the engine, and not after a stop by hand (ADR 0022).

## Considered Options

- **A trap for SIGTERM in the script**, for example `trap 'exit 143' TERM`. `sh` runs a trap only after its foreground command ends, so the sleeps of the passes and of the retries, and the long sleep of a reaper whose socket check failed, would delay the end. It also adds a second way to end, which must be safe at each point as well.
- **The SIGTERM of Ryuk.** Ryuk 0.14.0 takes SIGTERM as a request to finish: it closes its listener and then prunes (`main.go` l.15, `reaper.go` l.331-345). Ryuk does not outlive a restart of its engine. A reaper that pruned at the stop of its engine would remove the objects of a run whose holders still live, which ADR 0022 forbids.
- **An init process** (`HostConfig.Init`, the `docker-init` of the engine). It gives SIGTERM to `sh`, which is then not PID 1 and ends at once. It needs an init binary on the engine's host (`docker-init`, or `catatonit` on Podman): an engine without one fails the start of every reaper, and the reaper is not tested on Podman and socktainer (ADR 0022).
- **A shorter `StopTimeout`.** The reaper ignores SIGTERM, so each stop still waits for that time.
- **The `--shutdown-timeout` of the engine.** It sets only the whole wait of the engine's stop; each container keeps its own stop timeout (`daemon/daemon.go` l.1247-1267). The engine is also not the reaper's to configure.

## Consequences

- A stop of an engine that runs a reaper takes about 10 s less. The three tests that restart an engine, in one run of the nine tests of a second engine, on the devbox engine from the Mac: 22.1 s to 11.5 s, 24.9 s to 19.3 s, and 44.2 s to 35.4 s.
- A reaper has no time between a stop and its end. Before, it ran for 10 s more while its engine stopped.
- The test objects of those tests (`objectOn`, a `sleep` that is PID 1) have the same stop signal, for the same reason.
- The rebuild of the reaper (#5739, steps S3 to S9) keeps a reaper that a kill can end at each point. The stop signal goes with the container request, also into the package of S9.
- `EngineLease` and the claim of `DockerEngineStore` are containers of the same kind: `sh` as PID 1 with no trap. No test stops their engine. Backlog #6210 gives them the same stop signal.
