# The name is process, after the process type of .NET and Rust

Status: Accepted 2026-11-27 (backlog #6077).

Decision-makers: Ezz, on 2026-11-27, who chose "@zukhruf/process" from three names.

Go and .NET disagree on the name of the concept.

| Leader  | Module               | Main type                     |
| ------- | -------------------- | ----------------------------- |
| Go      | `os/exec`            | `Cmd`                         |
| .NET    | `System.Diagnostics` | `Process`, `ProcessStartInfo` |
| Rust    | `std::process`       | `Command`, `Child`            |
| Python  | `subprocess`         | `Popen`, `CompletedProcess`   |
| Deno    | `Deno`               | `Command`, `ChildProcess`     |
| Node.js | `node:child_process` | `ChildProcess`                |

## Decision

- The package is `@zukhruf/process`, in `packages/process`. The word is the concept of .NET's `Process` and of Rust's `std::process`, and a noun of one word, as `fs`, `lease` and `ssh` are.
- A started process is a `Process`, after .NET's `Process`. What to run is a `Command`, as in Go, Rust and Deno, and `run()` and `start()` are its methods ([ADR 0010](./0010-a-command-says-what-to-run-and-run-and-start-are-its-methods.md)). The statics of .NET are not copied: C# has them because it has no functions outside a class.
- "Coprocess" stays as a word of the glossary and as the class `Coprocess`, the JSON-lines view.

## Considered Options

- **`@zukhruf/exec`, after Go.** It names the act of running, and a started process that the parent keeps is more than a run.
- **`@zukhruf/subprocess`, after Python.** The package is about the process that this program starts, which "process" says with the glossary.
- **`@zukhruf/process`.** This option was selected.

## Consequences

- A file that uses the global `process` and the class `Process` reads both; they differ in case, as `process.env` and a `Process` from `start()`.
