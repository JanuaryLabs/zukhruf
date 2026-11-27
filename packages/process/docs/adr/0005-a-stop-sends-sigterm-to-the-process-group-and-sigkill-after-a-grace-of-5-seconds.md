# A stop sends SIGTERM to the process group, and SIGKILL after a grace of 5 seconds

Status: Accepted 2026-11-27 (backlog #6077).

Changed in part on 2026-11-27 (backlog #6161): CI has no Windows runner, so no Windows run probes the stop before the build, and by the ruling of 2026-10-20 no step waits for one. On Windows execa stops the process tree with `forceKillAfterDelay` and `killDescendants` on its own timers, not on the clock of the command. Its proof is backlog #6161.

Decision-makers: the zukhruf session of backlog #6077 proposes this from the leaders and from [coprocess ADR 0001](../../../coprocess/docs/adr/0001-the-exit-is-an-event-and-the-package-uses-execa.md). Ezz rules on it in the review of the paper.

A process can need time to stop. On 2026-10-26 a probe of coprocess ADR 0001 sent SIGTERM to three helpers: the Vision helper (Swift) and the transcription helper (Rust) stopped in 4 to 7 ms, and the Claude command-line program saved its state and stopped in about 900 ms. A process can also start its own children: `sshd` starts one `sshd` for each connection, and a shell starts its commands. SIGKILL to the first process leaves them running. In the other repositories, the wrappers stop with SIGKILL (sdk-it `runNode`, deepagents `AppleContainer`), with SIGINT (context-compiler `running` and `ambient`), or with SIGTERM and then SIGKILL after 2 s (text2sql `killGracefully`). Three files of zukhruf kill a process group by hand (`signalGroup` in the three copies of `sshd.ts`).

## The leaders

| Leader                   | Stop                                         | The step from SIGTERM to SIGKILL              | Children                                         |
| ------------------------ | -------------------------------------------- | --------------------------------------------- | ------------------------------------------------ |
| Go                       | `Cmd.Cancel` (default `Kill`)                | `Cmd.WaitDelay`                               | `SysProcAttr.Setpgid`; the caller signals `-pid` |
| CliWrap                  | a graceful and a forceful cancellation token | the time between the two tokens               | the forceful kill takes the process tree         |
| execa                    | `kill()`, a `cancelSignal`                   | `forceKillAfterDelay`, default 5000 ms        | `killDescendants`                                |
| Kubernetes               | SIGTERM to the container                     | `terminationGracePeriodSeconds`, default 30 s | the whole container                              |
| systemd                  | `KillSignal=SIGTERM`                         | `TimeoutStopSec`, default 90 s                | `KillMode=control-group`                         |
| Python, .NET, Deno, Rust | `terminate()`, `Kill()`, `kill()`            | none built in                                 | .NET `Kill(entireProcessTree)`                   |

## Decision

- `stop()` of a started process sends SIGTERM to its process group. When the group is still alive after the grace, it sends SIGKILL to the group. It resolves with the end of the process.
- The grace waits on the `clock` of the command, a required input with no default, as [root ADR 0004](../../../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md) asks of a library that waits. Thus a test proves a grace on a fake clock: a process that ignores SIGTERM still runs 1 ms before the grace and is gone at it, with no wait of seconds and no bound on the wall clock. The keeper's own wait after the end of its parent (ADR 0004) is `sleep` in `sh`, on the time of the machine, because no clock of the parent is left then.
- The grace is 5000 ms unless the caller gives `grace`. That is the default of execa, which coprocess uses today.
- An abort of the `signal` of a run or of a started process is a stop.
- The disposal of a started process (`await using`) is a stop that also waits for the streams to close.
- On Windows there are no signals and no process groups. What `killDescendants` and `forceKillAfterDelay` of execa do there is open: a Windows CI run probes it before the build, and its result goes into this ADR.

## Considered Options

- **SIGKILL at once**, as sdk-it and deepagents do. A process that saves its state loses it.
- **SIGTERM only.** A process with a handler that never ends stays.
- **Only the process, not its group.** The children of `sshd` and of a shell stay.
- **30 s, as Kubernetes.** A test waits 30 s for a process that ignores SIGTERM. 5 s gave the Claude program its 900 ms, and execa and coprocess already use it.
- **SIGTERM to the group, SIGKILL to the group after 5 s.** This option was selected.

## Consequences

- The three copies of `signalGroup` and text2sql's `killGracefully` go.
- A caller that needs another grace gives `grace`. A caller that needs SIGINT first sends it itself through `pid`; the package has no option for the first signal yet (later).
