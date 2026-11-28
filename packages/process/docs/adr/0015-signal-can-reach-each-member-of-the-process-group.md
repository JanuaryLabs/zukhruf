# signal can reach each member of the process group

Status: Accepted 2026-11-28 (backlog #6155).

Decision-makers: Ezz, on 2026-11-28. Of "Add { to: 'group' }" and "Keep process.kill", he chose "Add { to: 'group' }".

`signal(name)` sends a signal to the program alone ([ADR 0012](./0012-signal-sends-a-signal-to-the-program-alone-and-gives-false-when-the-program-has-ended.md)), and `stop()` sends SIGTERM, SIGCONT and SIGKILL to the whole group ([ADR 0005](./0005-a-stop-sends-sigterm-to-the-process-group-and-sigkill-after-a-grace-of-5-seconds.md), [ADR 0014](./0014-a-stop-sends-sigcont-after-its-sigterm-so-a-frozen-member-ends-in-the-grace.md)). The three sshd helpers of the tests (`packages/ssh`, `packages/docker` and `packages/testing`, `src/testing/sshd.ts`) send a signal of their choice to a whole group: SIGKILL to crash a connection, SIGSTOP to freeze it. After the login, `sshd -i` forks the child that serves the connection, and that child holds the socket too, so a signal to the program alone misses it. They called `process.kill(-pid, name)`.

## The leaders

| Leader  | A signal of the caller's choice to a whole group                  | Link                                                              |
| ------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| systemd | `systemctl kill --kill-whom=main\|control\|all --signal=<signal>` | https://www.freedesktop.org/software/systemd/man/systemctl.html   |
| Go      | none in `os/exec`; a caller calls `syscall.Kill(-pgid, sig)`      | https://pkg.go.dev/syscall#Kill                                   |
| .NET    | none                                                              | https://learn.microsoft.com/dotnet/api/system.diagnostics.process |

systemd has one kill with a target. The program is its default target, as `main` is in a unit.

## Decision

- `signal(name, { to: 'group' })` sends `name` to each member of the process group of the started process. Without `to`, or with `to: 'program'`, it sends to the program alone, as before.
- It gives `true` when it sent the signal, and `false` when the group had no member left, also when macOS answers EPERM for a group of zombies.
- A SIGSTOP that reaches a member while it is between its fork and its exec can be lost (probed on macOS on 2026-11-28: lost in 2 of 4 runs right after the first line of output, in 0 of 10 runs after both members had exec'd), so a caller signals a group when its members run, as after a ready line.

## Considered Options

- **Keep `process.kill(-pid, name)` in the three helpers.** Each catches ESRCH and EPERM itself, and the three copies stay.
- **A second method, `signalGroup(name)`.** Two methods for one act, which only their target sets apart.
- **One `signal` with a target, as systemd's kill.** This option was selected.

## Consequences

- The three sshd helpers send SIGKILL and SIGSTOP to a connection with `signal(name, { to: 'group' })`, and their own `signalGroup` goes.
- A group whose members all ended gives `false`. A group number that the system gave again to a new group after all members ended would get the signal; the package sends to a group only through a call of the caller, as `stop()` does.
