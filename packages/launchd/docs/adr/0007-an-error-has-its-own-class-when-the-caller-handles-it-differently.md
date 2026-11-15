# An error has its own class when the caller handles it differently

The maintainer's rule for errors is in [docker ADR 0007](../../../docker/docs/adr/0007-an-error-has-its-own-class-when-the-caller-handles-it-differently.md): "I prefer naunced error classes for cases where an error expcetion actually make a differnce." (2026-10-20). A class for each exit code of launchctl would give classes that no caller handles. One class with the exit code would make each caller decode the code again.

The exit codes of launchctl, decoded with `launchctl error` on macOS 27.2 (research record, 2026-11-15):

| Code                      | Meaning                                                                                                                                                                                                                | Where it comes from                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1                         | Operation not permitted                                                                                                                                                                                                | A change that needs root, such as a change of the `system` domain (launchctl(1), lines 30-32)              |
| 3                         | No such process                                                                                                                                                                                                        | A bootout of a label that launchd does not have                                                            |
| 5                         | Input/output error                                                                                                                                                                                                     | A bootstrap that fails with no reason. stderr says "Try re-running the command as root for richer errors." |
| 36                        | Operation now in progress                                                                                                                                                                                              | A bootout while the last one still runs                                                                    |
| 113                       | Could not find specified service                                                                                                                                                                                       | `print`, `kickstart` or `list` of a label that the domain does not have                                    |
| 119                       | Service is disabled                                                                                                                                                                                                    | Not yet seen from a subcommand of the package                                                              |
| 17, 22, 37, 125, 134, 150 | File exists, Invalid argument, Operation already in progress, Domain does not support specified action, Service cannot load in requested session, Operation not permitted while System Integrity Protection is engaged | No consumer handles them                                                                                   |

What the consumers do with them:

- context-compiler reads 3 and 36 in its bootout loop (`apps/cli/src/background-watch.ts:89-94`). The package handles both inside the bootout wait ([ADR 0004](./0004-a-bootout-is-repeated-until-launchd-forgets-the-service.md)).
- mac-cleanup reads 113 of `print` as "not loaded" (`src/tasks/macos/launch-agents.ts:65`). In the package that is a state, not an error ([ADR 0006](./0006-the-state-of-one-service-comes-from-print-and-only-two-of-its-lines.md)).
- No leading tool handles 5, 37 or 113 in a way of its own.

## Considered Options

- **One class with the exit code.** Each caller decodes the code again.
- **A class for each exit code.** Most of them have no handling of their own.
- **A class for each case that a caller handles differently.** This option was selected.

## Consequences

- The package has a class for each of these cases, and for no others:
  - `ServiceNotFoundError`: `kickstart()` or `kill()` gets exit code 113. The caller installs the job, or bootstraps its job file.
  - `PermissionDeniedError`: the write or the removal of a job file fails with `EACCES` or `EPERM`, or launchctl exits 1. The caller runs as root, or installs an agent.
  - `LaunchdUnavailableError`: `/bin/launchctl` does not start (`ENOENT`). This system is not macOS, and the caller skips the work for launchd.
  - `ServiceDisabledError`: only if bootstrap of a disabled service gives its own exit code; the build probes it. The caller enables the service, then bootstraps it.
- `LaunchdError` is the base of every error of the package. `LaunchctlError` extends it, and it is the base of every answer of launchctl that is an error. It has `args`, `exitCode` and `stderr`. An exit code with no class of its own is a `LaunchctlError`.
- Exit code 5 has no class. Its next step is the next step of the base class: read `stderr`, and try again as root for "richer errors". A class would add a name and no handling.
- `PermissionDeniedError` comes from two places, the file and launchctl, so it extends `LaunchdError`, not `LaunchctlError`. Its `cause` is the error of Node.js or the `LaunchctlError`.
- The package has no class for a job that another program installed, for a job file that launchd cannot read, or for a failed bootstrap. The package does not record who installed a job. The type of a job keeps out a job that launchd.plist(5) does not allow ([ADR 0002](./0002-a-job-is-the-typed-launchd-plist-with-apples-key-names.md)). A failed bootstrap is a `LaunchctlError` with its exit code.
- A cancel rejects with the reason of the signal, not with a `LaunchdError` ([the async glossary](../../../async/CONTEXT.md)).
- Another error of the file system, such as `ENOSPC`, stays the error of Node.js with its `code`.
