# The package keeps no state

Status: Accepted 2026-11-26 (backlog #5747).

Decision-makers: the maintainer, by his standing rules quoted below and on 2026-11-26 ("we force the host into proper package design not the other way around"); the context-compiler session context-compiler-99.

elt's `macOSAccess` is a module-level instance with an `install({ program })` slot (`packages/sdks/macos/app-database/src/macos-access.ts`). On 2026-11-13 (#4336) the maintainer approved that design: the macOS SDK layer owns one sentence for each kind of grant, and each host's entry point installs its program name once. His later rules settle what replaces it: "no module levels or singletons. at all" (2026-07-25), "a host decision is a package gap" (2026-10-07), and "we force the host into proper package design not the other way around" (2026-11-26). With the client from macOS ([ADR 0004](./0004-the-client-comes-from-macos-through-node-ffi.md)), no host has a name to install.

## Decision

The package exports classes and no instance. It has no slot that a host fills. A service class holds only constants, and `Client.responsibleFor()` asks macOS on each call.

## Considered Options

- **Keep an instance with an `install()` slot**, as elt does. A module-level instance, and a decision of the host.
- **No state.** This option was selected.

## Consequences

- This reverses the part of #4336 that puts the sentence in elt's SDK layer and the name in each host. elt's `macOSAccess` and the CLI's `responsibleProgram()` are deleted when they move onto the package. Each `Store` names a service class.
- An SDK that builds an error asks for the client at that time. The cost is one call through `node:ffi`.

## Confirmation

- `src/index.ts` exports classes only; a test imports the package twice in one process and finds no shared state.
