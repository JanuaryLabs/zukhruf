# The client comes from macOS, through node:ffi

Status: Accepted 2026-11-26 (backlog #5747).

Decision-makers: the maintainer, on `node:ffi` over a native addon (he chose "node:ffi now", 2026-11-26); the context-compiler session context-compiler-99 on the rest.

The remedy must name the client that the user turns on. Today the hosts find it. elt's `macOSAccess` keeps a name that the host installs once per process (`packages/sdks/macos/app-database/src/macos-access.ts`). The context-compiler CLI finds the name from `__CFBundleIdentifier` and Spotlight, or takes its own `node` when `XPC_SERVICE_NAME` says that launchd started it (`apps/cli/src/main.ts:39-57`). That is a decision of the host about a fact of macOS: "when a host must decide something that means our packages are wrong or not extensible enough" (the maintainer, 2026-10-07).

macOS knows the answer. libSystem exports `responsibility_get_pid_responsible_for_pid(pid)`, and `proc_pidpath(pid, buffer, size)` gives the path of the responsible process. A probe on 2026-11-26 (Node 26.13.1, macOS 27.2) gave `/Applications/cmux.app/Contents/MacOS/cmux` for a process in the terminal app, and `…/node/v26.13.0/bin/node` for the launchd job of the context-compiler watch, which is its own responsible process. `responsibility_get_pid_responsible_for_pid` has no header in the SDK: it is private, and Apple can change it. Node 26 has `node:ffi`, which calls it with no toolchain. Node marks `node:ffi` experimental and writes an `ExperimentalWarning` when a process first uses it. With `--permission`, a process needs `--allow-ffi`.

The maintainer chose `node:ffi` over a native addon on 2026-11-26.

## Decision

`Client.responsibleFor(pid)` calls the two functions through `node:ffi`. A path inside a `.app` folder gives a client of type `bundle`, with the path of the folder and its name without `.app`. Any other path gives a client of type `executable`, named by its path. `Client.bundle(path)` and `Client.executable(path)` make a client for a program that has no process yet. The package loads `node:ffi` only in the calls that need it.

## Considered Options

- **The host installs the name**, as elt does now. It needs a module-level instance and a decision of each host.
- **Environment variables and Spotlight**, as the CLI does now. `TERM_PROGRAM` names the wrong app under cmux, and a missing Spotlight index gives no name.
- **A native addon**, as node-mac-permissions. It needs node-gyp and Xcode at install.
- **`node:ffi`.** This option was selected.

## Consequences

- The name of a bundle is the name of its folder. System Settings can show a localized name, such as "Terminal" for `Terminal.app`, which is the same in English.
- The tests run on the macOS job of CI ([root ADR 0005](../../../../../docs/adr/0005-a-project-that-needs-macos-runs-its-targets-on-a-macos-runner.md)), so a change of the private function shows on the next macOS.

## Confirmation

- Probe of 2026-11-26 (Node 26.13.1, macOS 27.2): `responsibility_get_pid_responsible_for_pid` and `proc_pidpath` through `node:ffi` gave `/Applications/cmux.app/Contents/MacOS/cmux` for a process in the terminal app, and the `node` of the launchd job of the context-compiler watch for that job. `node:ffi` loaded with no flag and wrote one `ExperimentalWarning`.
- `responsibility_get_pid_responsible_for_pid` is in `libSystem.B.tbd` of MacOSX27.2.sdk and in no header.
