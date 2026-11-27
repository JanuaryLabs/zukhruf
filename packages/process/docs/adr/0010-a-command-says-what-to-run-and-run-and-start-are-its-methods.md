# A command says what to run, and run and start are its methods

Status: Accepted 2026-11-27 (backlog #6077).

Decision-makers: Ezz, on 2026-11-27. In the review of the paper (03a86832) he asked: "what's the deal with the static method? Why everything is a static method? I don't mind if they are necessary, but I don't want you just to be copying other code blindly." Of a command value and plain functions, he chose "B: a Command value".

The paper had `Process.run`, `Process.start`, `NodeProcess.run`, `NodeProcess.start` and `Coprocess.start`, all static, after `Process.Start` and `Process.RunAndCaptureTextAsync` of .NET. .NET makes them static because C# has no functions outside a class. TypeScript has them, so that reason does not hold here. `Process.run` gave a `Completed` and never made a `Process`, so its static had no reason at all. A start must wait for the file lookup and for the ready line, and a constructor cannot wait. That is a reason for some call other than `new`, but not for a static.

## The leaders

The leaders whose languages have functions outside a type split what to run from the act:

| Leader  | What to run                                  | The act                                          | Link                                                                       |
| ------- | -------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| Go      | `exec.Command(name, args...)` gives a `*Cmd` | `Run`, `Output`, `CombinedOutput`, `Start`       | https://pkg.go.dev/os/exec                                                 |
| Rust    | `Command::new(program)`                      | `output()`, `status()`, `spawn()`                | https://doc.rust-lang.org/std/process/struct.Command.html                  |
| Deno    | `new Deno.Command(command, options)`         | `output()`, `outputSync()`, `spawn()`            | https://docs.deno.com/api/deno/~/Deno.Command                              |
| .NET    | `ProcessStartInfo`                           | `Process.Start(startInfo)` (static, as C# needs) | https://learn.microsoft.com/dotnet/api/system.diagnostics.processstartinfo |
| Python  | the arguments of a call                      | `subprocess.run(...)`, `Popen(...)`              | https://docs.python.org/3/library/subprocess.html                          |
| Node.js | the arguments of a call                      | `spawn(...)`, `execFile(...)`                    | https://nodejs.org/api/child_process.html                                  |

## Decision

- `new Command(file, args, { env, cwd, grace, name })` holds what to run and starts nothing.
- `command.run({ input, signal })` runs it to its end and gives a `Completed`. `command.start({ ready, signal, stdin, stdout, stderr })` gives a started process. What belongs to one call (the signal, the input, the ready line, the stdio of one start) is an option of the call, because a command can run or start more than once: a pool starts the same worker again when one exits, and `sshd -i` starts once for each connection with that connection as its stdio. Deno puts every option in the command; this package does not, for that reason.
- `Process` is an interface. Only `start()` makes one, through a class that the package does not export. Thus no static and no hidden factory is needed for it.
- `start()` gives a `PipedProcess`, whose `stdin` is never `null`, when stdin and stdout stay piped (the default). `Coprocess` takes a `PipedProcess` in its constructor, so a coprocess over a process without pipes does not type-check.
- `new NodeCommand(source, { env, nodeOptions, ... })` does the same for JavaScript source, and its `start()` gives a `NodeProcess`, the only process with messages ([ADR 0007](./0007-json-lines-and-messages-are-views-of-a-started-process-and-only-a-node-process-has-messages.md)).

## Considered Options

- **Statics on `Process`, after .NET.** C#'s reason for them does not hold in TypeScript, and `run` is a static that makes no instance.
- **Functions: `run(file, args, options)`, `start(...)`, `startNode(...)`**, as Python and Node.js do. The fewest types and the shortest call. A caller that runs the same thing again repeats its file, arguments and environment, or writes a closure.
- **A command value with `run` and `start`**, as Go, Rust and Deno do, and as .NET's `ProcessStartInfo` does. This option was selected.

## Consequences

- Each class has one job: `Command` and `NodeCommand` say what to run, a `Process` is a process that runs, and `Coprocess` and `NodeProcess` are views of it.
- A call site is one line longer than a function: `await new Command('git', ['status'], { env }).run()`.
- [ADR 0009](./0009-the-name-is-process-after-the-process-type-of-dotnet-and-rust.md) keeps the package name; its class names follow this ADR.
