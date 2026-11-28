# A stop sends SIGCONT after its SIGTERM, so a frozen member ends in the grace

Status: Accepted 2026-11-28 (backlog #6155).

Decision-makers: the zukhruf session mutex-94 decided it from a probe and from systemd, as a defect of the stop of [ADR 0005](./0005-a-stop-sends-sigterm-to-the-process-group-and-sigkill-after-a-grace-of-5-seconds.md).

A frozen process (SIGSTOP) keeps a SIGTERM pending until it runs again. The stop of ADR 0005 sent SIGTERM and then, after the grace, SIGKILL, so a frozen member that handles SIGTERM did not end until the SIGKILL. A probe of 2026-11-28 (backlog #6155, the sshd helper of the tests, whose monitor handles SIGTERM): a frozen program that exits at SIGTERM, stopped with a grace of 2000 ms, ended by SIGKILL after 2003 ms; with a SIGCONT after the SIGTERM, it ended with exit code 0 after 13 ms. The three sshd helpers sent that SIGCONT themselves.

systemd's `kill_and_sigcont()` (`src/basic/process-util.c`) does the same: "If this worked, also send SIGCONT, unless we already just sent a SIGCONT, or SIGKILL was sent which isn't affected by a process being suspended anyway."

## Decision

- A stop sends SIGTERM to the process group, then SIGCONT to the group, and SIGKILL to the group when it still runs after the grace.
- SIGKILL needs no SIGCONT: it ends a frozen process too.

## Consequences

- A frozen started process ends at its own SIGTERM handler, with its own end, in place of `{ signal: 'SIGKILL' }` at the end of the grace.
- A member that ignores SIGTERM runs again for the rest of the grace before its SIGKILL.
- The sshd helpers of the tests no longer send SIGCONT at their disposal.
