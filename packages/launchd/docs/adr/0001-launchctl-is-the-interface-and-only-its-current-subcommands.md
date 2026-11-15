# launchctl is the interface, and only its current subcommands

A Node.js program has three ways to give a job to launchd. It can run `launchctl`. It can call SMAppService of the ServiceManagement framework. Or it can write the files that launchd keeps. The package uses `launchctl`, and only the subcommands that launchctl(1) does not call legacy.

launchctl(1) puts `load`, `unload`, `start`, `stop`, `list`, `submit` and `remove` under "LEGACY SUBCOMMANDS" (launchctl(1), lines 353-472). For `load` and `unload` it says "Recommended alternative subcommands: bootstrap | bootout | enable | disable" (lines 358-360). For `list` it says "Recommended alternative subcommand: print" (lines 459-460). Two facts make the legacy subcommands wrong for a library:

- "Legacy subcommands select the target domain based on whether they are executed as root or not" (lines 354-356). A caller cannot name the domain.
- "the load and unload subcommands will only return a non-zero exit code due to improper usage. Otherwise, zero is always returned" (lines 421-424). A caller cannot see that a load failed.

The survey of the leading tools (research record, 2026-11-15) found:

- Only Homebrew services uses `bootstrap`, `bootout` and `enable` (`cli.rb:465-473`).
- nix-darwin, Ansible's `community.general.launchd`, kardianos/service and Puppet's launchd provider use the legacy `load` and `unload`.
- Puppet changes the disabled state of a job in launchd's own file. launchctl(1) says that this state "is stored elsewhere on-disk in a location that may not be directly manipulated by any process other than launchd" (lines 379-385).
- No surveyed tool uses `kickstart`, and none uses the current `kill`.

SMAppService registers a job that is inside an app bundle (`Contents/Library/LaunchAgents`), and Node.js can call it only through a native binding. `BundleProgram`, its key for the program, "is only supported for plists that are installed using SMAppService" (launchd.plist(5), lines 131-134).

A restart of a service with no change to its job is `kickstart -k`: "If the service is already running, kill the running instance before restarting the service" (launchctl(1), lines 97-102). No surveyed tool uses it. They all reload the job file instead: `unload` and `load`, or `bootout` and `bootstrap`. A reload is correct when the job changed, because launchd keeps the job that it loaded: launchctl(1) calls `debug` "a convenient alternative to editing the launchd.plist(5) for the service and then reloading it" (lines 130-133). Thus `install` of a changed job reloads ([ADR 0003](./0003-install-is-a-reconcile-that-enables-then-bootstraps.md)), and `kickstart({ kill: true })` restarts without a reload.

## Considered Options

- **The legacy `load` and `unload`, as nix-darwin, Ansible, kardianos and Puppet.** The domain follows the user that runs the command, and a failed load exits 0.
- **SMAppService.** It needs an app bundle and a native binding. A command-line program or a script has neither.
- **Write the disabled state of launchd, as Puppet.** launchctl(1) says that only launchd may change it.
- **The current subcommands: `bootstrap`, `bootout`, `enable`, `disable`, `kickstart`, `kill` and `print`.** This option was selected.

## Consequences

- Each call of the package runs one or more of these seven subcommands. The README lists them for each call, in "Each call and what it runs".
- The package runs `/bin/launchctl` by its absolute path, with `execFile` and no shell. The `PATH` of the caller does not change which `launchctl` runs.
- An exit code that is not 0 is the error. "it will exit with an error code that can be given to the error subcommand to be decoded into human-readable form" (launchctl(1), lines 585-588). [ADR 0007](./0007-an-error-has-its-own-class-when-the-caller-handles-it-differently.md) gives the classes.
- `kickstart({ kill: true })` restarts the process of a loaded service, and launchd does not read the job file again. To change the job, call `install` with the changed job.
- `enable` and `disable` set launchd's override through launchctl. The package never writes launchd's own files.
- `print` is the only subcommand whose output the package reads, and Apple says that the output "is NOT API" (launchctl(1), lines 222-224). [ADR 0006](./0006-the-state-of-one-service-comes-from-print-and-only-two-of-its-lines.md) says how the package stays safe. `kickstart -p` prints a PID, which its flag documents (launchctl(1), lines 104-105).
- The package does not use the diagnostic subcommands. Apple says that the output of `blame` "should not be relied upon in production scenarios" (launchctl(1), lines 210-212), and the same of `procinfo` (lines 243-245).
