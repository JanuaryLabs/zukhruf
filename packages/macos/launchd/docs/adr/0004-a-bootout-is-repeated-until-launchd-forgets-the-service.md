# A bootout is repeated until launchd forgets the service

`launchctl bootout` answers before the process of the service is gone, and launchd refuses a bootstrap of the label until then. context-compiler found this: "launchd answers before the process is gone and refuses the label until then, so this asks again until launchd has no such job, as brew services does" (`apps/cli/src/background-watch.ts:80-83`). Thus `install` of a changed job, `bootout` and `uninstall` must wait until launchd forgets the service.

Two exit codes tell the state (decoded with `launchctl error` on macOS 27.2): 36 is "Operation now in progress", and 3 is "No such process". A bootout of a label that launchd does not have answers 3.

A probe on macOS 27.2 (2026-11-15) never saw 36. A job that ignores `SIGTERM`, with `ExitTimeOut` 3, answered 0 to each `bootout` every 250 ms for 3 seconds, while `print` showed `state = SIGTERMed`, and then 3. Eight bootouts at once all answered 0. A `bootstrap` of the label in those 3 seconds exited 5 (Input/output error). A `/bin/sleep` job answered 0, and 3 to the next bootout 60 ms later.

The leading tools and context-compiler (research record, 2026-11-15):

- Homebrew runs `bootout` again every second while it answers 36 or the service is still found, up to 60 seconds by default (`cli.rb:291-329`, `stop.rb:37`). It stops on 3 and on 125 (`system.rb:14`).
- context-compiler runs `bootout` again every 100 ms. 3 ends the loop, 36 runs it again, and another code throws (`background-watch.ts:84-98`).
- Ansible sleeps 5 seconds one time. kardianos/service sleeps 50 ms one time. nix-darwin and Puppet do not wait.

Node.js has no event for the exit of a process that is not its own child, and launchctl gives no event when launchd forgets a service. Thus the wait is a poll. [Root ADR 0004](../../../../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md) says that a library that waits takes the clock as an input. The bootout wait is `poll` of `@zukhruf/async` on the caller's clock: each attempt runs `launchctl bootout <target>`, 3 ends the poll, 0 and 36 wait one second, and another code rejects.

Two things end the wait. The first is the caller's signal. The second is launchd itself: when the job is to be stopped, launchd sends `SIGTERM`, and `SIGKILL` after `ExitTimeOut` (launchd.plist(5), lines 319-323). The package adds no time limit of its own.

## Considered Options

- **One bootout and no wait, as nix-darwin and Puppet.** A bootstrap right after it fails while the old process still ends.
- **A fixed sleep, as Ansible (5 s) and kardianos (50 ms).** It is too long for a fast job and too short for a slow one.
- **A poll of `print` until it answers 113.** It runs two subcommands where one does the work, and it reads output that is not API.
- **`bootout` again every second until it answers 3, as Homebrew.** This option was selected.

## Consequences

- `bootout()`, `uninstall()` and `install()` of a changed job use the same wait.
- The interval is Homebrew's, one second. A bootout of a job that ends at once takes one second, because the second bootout comes after one interval. context-compiler's 100 ms was faster. The interval is fixed: no caller needs another one.
- A job with `ExitTimeOut` 0 never gets `SIGKILL`: "The value zero is interpreted as infinity and should not be used" (launchd.plist(5), lines 322-323). Only the caller's signal then ends the wait.
- A cancel stops the wait, not the bootout. launchd goes on and forgets the service later. The call rejects with the reason of the signal ([the async glossary](../../../../async/CONTEXT.md)).
- Homebrew also ends the loop on 125, "Domain does not support specified action" (`system.rb:14`). Homebrew runs the loop once for each of its candidate domains (`cli.rb:300`), so for Homebrew 125 means "not in this domain, try the next one". The package names one domain, and 125 does not say that launchd forgot the service there. It rejects with `LaunchctlError`.
- Exit code 1 rejects with `PermissionDeniedError`, and another code rejects with `LaunchctlError` ([ADR 0007](./0007-an-error-has-its-own-class-when-the-caller-handles-it-differently.md)).
- The tests give `globalThis` as the clock, because they wait for a real launchd ([root ADR 0005](../../../../../docs/adr/0005-a-project-that-needs-macos-runs-its-targets-on-a-macos-runner.md)).
