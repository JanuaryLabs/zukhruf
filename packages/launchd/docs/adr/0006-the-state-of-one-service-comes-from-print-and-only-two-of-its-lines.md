# The state of one service comes from print, and only two of its lines

A caller asks three questions about a service. Is it loaded? Does its process run, and with which PID? How did its process end the last time? Two subcommands answer them:

- `print <service-target>`. Its output includes "information about its origin on-disk, its current state, execution context, and last exit status" (launchctl(1), lines 218-220). But: "IMPORTANT: This output is NOT API in any sense at all. Do NOT rely on the structure or information emitted for ANY reason. It may change from release to release without warning." (lines 222-224).
- The legacy `list <label>`. Its output "should match their output on previous OS X releases" (lines 553-561). It prints a dictionary in the old style, such as `"LastExitStatus" = 9;` and `"PID" = 832;`. But "Legacy subcommands select the target domain based on whether they are executed as root or not" (lines 354-356). `list` cannot name a domain: it cannot read the `system` domain for a user, or tell `gui/<uid>` from `user/<uid>`.

The leading tools and the consumers (research record, 2026-11-15):

- Homebrew reads `print <domain>/<label>` with two patterns, `pid =` and `last exit code =` (`formula_wrapper.rb:498-525`).
- Ansible, kardianos/service and Puppet read `list`.
- mac-cleanup runs `print`, and takes exit code 113 as "not loaded" (`src/tasks/macos/launch-agents.ts:56-69`). The end-to-end test of context-compiler reads the PID from `print` (`apps/cli/src/cli.e2e.test.ts:4211-4330`).

A probe on macOS 27.2 showed the lines:

- `print` of a label that the domain does not have exits 113, "Could not find specified service". So does `list`.
- `print gui/501/com.apple.Finder` shows `state = running`, `pid = 832` and `last exit code = (never exited)`.
- A service that ran and ended shows `state = not running` and `last exit code = 0`, with no `pid` line.
- A service that the system ended for memory (a jetsam exit) shows `last exit reason = JETSAM_REASON_MEMORY_IDLE_EXIT`, and no `last exit code` line. `list` shows `"LastExitStatus" = 9` for it.
- A job of `/usr/bin/false` shows `last exit code = 1`, and a job of `/bin/sh -c 'exit 3'` shows `last exit code = 3`. A loaded job that never ran shows `state = not running` and `last exit code = (never exited)`.
- A process that `launchctl kill SIGTERM` or `kickstart -k` ended shows `last terminating signal = Terminated: 15`, and `kill 9` shows `last terminating signal = Killed: 9`. Neither shows a `last exit code` line.
- Right after a bootstrap, a service shows `state = xpcproxy` and its `pid` line.
- The two lines are at the top level of the output, indented with one tab. Nested sections, such as `resource coalition`, indent their lines with two tabs, and some have a `state =` line of their own.

## Considered Options

- **`list <label>`, the output that Apple keeps stable.** It reads the domain of the caller, not the domain of the handle, so it can answer for the wrong service.
- **`print` of the whole domain, and a search for the label in its list of services.** It reads much more output that is not API, and the list of a domain has a format of its own.
- **`print` of one service: exit code 113 for "not loaded", and only the lines `pid =` and `last exit code =`, as Homebrew.** This option was selected.

## Consequences

- `state()` gives `{ state: 'not loaded' }` for exit code 113. With a `pid` line, it gives `running` and the PID. With no `pid` line, it gives `not running`.
- `lastExitStatus` is the number of the `last exit code` line. It is `undefined` when the line has no number, as `(never exited)`, and when there is no such line, as after a jetsam exit or a process signal.
- The package reads only the two lines at the top level: the line starts with one tab. A process signal shows in `last terminating signal`, which the package does not read, so a process that a signal ended has no `lastExitStatus`. With no label, `list` shows "the negative of the signal which stopped the job" in its second column (launchctl(1), lines 462-468): `-9` for the jetsam exit above, which `list <label>` shows as `9`.
- The package stays safe on output that is not API in three ways. "Not loaded" comes from the exit code, and launchctl(1) documents the exit code as the error (lines 585-588). The package reads two lines, and no other part of the output can break it. The macOS CI job runs the real `print` on each runner image, so a change of the two lines fails a test there ([root ADR 0005](../../../../docs/adr/0005-a-project-that-needs-macos-runs-its-targets-on-a-macos-runner.md)).
- A change of Apple that drops or renames `pid =` makes a running service look `not running`. The tests on the macOS runner find it, and the parser follows the new line.
- `state()` of a daemon needs no root: "Anyone may read or query the system domain" (launchctl(1), lines 30-31).
- No other output is parsed. `print-disabled` is not read: no consumer asks whether a service is disabled.
