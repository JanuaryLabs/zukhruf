# @zukhruf/process

> **In build (backlog #6077).** `Command#run` and `Command#start` are built. `NodeCommand` and `Coprocess` follow, in that order; until then, this README describes them as decided in the ADRs.

Start a process of this machine and know how it ends. A `Command` says what to run: the file, its arguments, the environment, the folder. `command.run()` runs it to its end and gives its exit code or signal and its output, with no throw at a non-zero exit. `command.start()` gives a started process: it resolves when the process is ready, it stops the process group with SIGTERM and then SIGKILL, and the process ends with its parent, also when the parent is killed. A `Coprocess` talks to a started process in JSON lines, and a `NodeCommand` runs JavaScript source in its own Node.js with messages.

The package replaces `@zukhruf/coprocess` and the `process` area of `@zukhruf/testing`, which move here ([ADR 0001](./docs/adr/0001-one-package-starts-a-process-for-a-run-and-for-a-started-process-and-coprocess-and-the-test-worker-move-into-it.md)).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/process
```

```ts
import { Command } from '@zukhruf/process';

const lint = await new Command('npx', ['eslint', 'src'], {
  env: process.env,
  clock: globalThis,
}).run();
if (lint.exitCode !== 0) console.error(lint.output);
```

## Say what to run

`new Command(file, args, options)` holds what to run, and starts nothing. `options` are `env` and `clock` (both required), `cwd`, `grace` and `name`. The clock runs the grace, as [root ADR 0004](../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md) asks of each library that waits: an app gives `globalThis`, and a test can give the clock of `@sinonjs/fake-timers`. A command can run or start more than once, as a pool does when it replaces a worker. What belongs to one call, the `signal`, the `input` and the ready line, goes to `run()` or `start()` ([ADR 0010](./docs/adr/0010-a-command-says-what-to-run-and-run-and-start-are-its-methods.md)).

## Run a command to its end

`command.run({ input, signal })` resolves when the process has ended and its streams have closed. It gives the end and the output ([ADR 0002](./docs/adr/0002-a-run-gives-its-end-as-a-value-an-exit-code-or-a-signal-and-rejects-only-when-the-process-cannot-start-or-its-signal-aborts.md)).

```ts
const status = new Command('git', ['status', '--porcelain'], {
  env: process.env,
  clock: globalThis,
  cwd: repository,
});
const run = await status.run();
// run.exitCode is 0, or run.signal names the signal that ended it.
// run.stdout, run.stderr, and run.output with both in the order written.
```

- The end is `{ exitCode }` or `{ signal }`. A non-zero exit code is a value, not a rejection.
- The text is not trimmed. `stdout` keeps its last newline.
- `input` goes to stdin, and then stdin ends. Without `input`, stdin ends at once.
- `env` is required, and it is the whole environment of the process. Write `env: process.env` to pass your own ([ADR 0003](./docs/adr/0003-the-environment-is-a-required-input-and-the-process-gets-only-what-the-caller-names.md)).
- An abort of `signal` stops the process and rejects with the reason of the signal.

## Start a process and wait until it is ready

`command.start({ ready, signal, stdin, stdout, stderr })` starts the process and resolves when it is ready: at the first line of stdout that `ready.line` names ([ADR 0006](./docs/adr/0006-a-started-process-is-ready-at-a-line-or-a-message-that-the-caller-names-and-an-end-before-it-rejects.md)). Without `ready`, it resolves after the start.

```ts
const owner = new Command(process.execPath, ['owner.js', path], {
  name: 'owner',
  env: process.env,
  clock: globalThis,
});
await using holding = await owner.start({
  ready: { line: 'holding' },
  signal: t.signal,
});
```

- `line` is a string that a whole line equals, or a regular expression that a line matches.
- When the process ends before it is ready, the start rejects with `EndedBeforeReadyError`, which holds the end and the stderr tail.
- The wait has no time limit of its own. The `signal` is its limit; in a test, give `t.signal`.
- `lines()` of the started process gives the lines of stdout from the first one, also those that came before the call. After the ready line, the package reads stdout only while a caller iterates `lines()`. A process that writes much to stdout that nobody reads waits at its write, as with a pipe in a shell; give `stdout: 'ignore'` for such a process.
- `stdin` and `stdout` can also be a `net.Socket` that the process gets as its own, as `sshd -i` needs for each connection. A ready line needs `stdout: 'pipe'`, the default, and the type allows `ready` only then.

## The end of a started process

`ended` settles once, with the end, when the process has ended. A pool or a supervisor awaits it; there is no property to read, because a read and an end can race ([coprocess ADR 0001](../coprocess/docs/adr/0001-the-exit-is-an-event-and-the-package-uses-execa.md)).

A started process ends when this program ends, also when this program is killed with SIGKILL ([ADR 0004](./docs/adr/0004-a-started-process-ends-with-its-parent-also-when-the-parent-is-killed.md)). On macOS and Linux, each process starts under a keeper in POSIX `sh`: it leads the process group, and it stops the group when the pipe from this program closes. It costs about 5 ms at the start and 2 to 4 MB while the process runs. A process that must outlive this program is not a started process of this package.

- On Windows there is no keeper: execa starts the file, and a process does not end yet with a parent that is killed. A job object, as .NET 11 uses, is on the map as later, with the proof of the Windows path (backlog #6161).
- `sh` cannot tell an exit code above 128 from a signal, so a process that exits with 130 ends as `{ signal: 'SIGINT' }`.
- A child of the process that leaves the group (`setsid`, `detached: true`) does not end with it.

## Stop a started process

`stop()` sends SIGTERM to the process group. When the group is still alive after the grace, 5 seconds unless the caller gives `grace`, it sends SIGKILL to the group. It resolves with the end when no member of the group is left ([ADR 0005](./docs/adr/0005-a-stop-sends-sigterm-to-the-process-group-and-sigkill-after-a-grace-of-5-seconds.md)). A member that has ended but that its parent has not reaped yet (a zombie) is still in the group, so a zombie that no parent reaps holds the stop until the grace. An abort of `signal` is a stop. The disposal (`await using`) is a stop that also waits until the streams have closed.

## Talk to a coprocess in JSON lines

`new Coprocess(process)` talks to a started process that reads one JSON value on each line of stdin and writes one on each line of stdout. `request(value)` sends a value and receives the next one. `send` and `receive` do each half. `close()` ends stdin and waits for the end ([ADR 0007](./docs/adr/0007-json-lines-and-messages-are-views-of-a-started-process-and-only-a-node-process-has-messages.md)). The process must have its stdin and stdout piped, the default of `start()`, and the type allows only such a process.

```ts
const worker = new Command('/path/to/vision-worker', [], {
  name: 'Vision worker',
  env: process.env,
  clock: globalThis,
});
await using ocr = new Coprocess(await worker.start());
const answer = await ocr.request({ path: '/tmp/receipt.png' });
```

`exited()` settles once, with the error that each later `receive` gets, as in `@zukhruf/coprocess` today, and `coprocess.process` is the started process.

## Run JavaScript source in its own Node.js

`new NodeCommand(source, options)` says to run `source` as an ES module in a new Node.js, with an IPC channel back to this process. `options` are those of `Command` and `nodeOptions`, the Node.js flags before the source. `start()` gives a `NodeProcess`: `next(match, { signal })` resolves with the first message that `match` selects, sent before or after the call, a `type` or a function of the message, and `send(message)` sends one. Its `ready` also takes `{ message }`, and `admit` gets the child before it can send. `run()` runs the source to its end and gives what `Command#run` gives.

```ts
const holder = new NodeCommand(
  `
  import { connect } from 'node:net';
  // ... take the lock, then:
  process.send({ type: 'held' });
  `,
  { name: 'holder', env: process.env, clock: globalThis },
);
await using held = await holder.start({
  ready: { message: 'held' },
  signal: t.signal,
});
```

Only a `NodeProcess` has messages, because only a Node.js child can use the channel.

## Errors

| Error                                             | When                                                                                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StartError`                                      | The process could not start, for example because the file does not exist. Its `cause` is the error of the start (`ENOENT`, `EACCES`). `run()` and `start()` reject with it.                                 |
| `EndedBeforeReadyError`                           | A started process ended before it was ready. It has `end` and `stderr` (the stderr tail). Its message names the process and the end, never the command line, because arguments can hold prompts or secrets. |
| the reason of `signal`                            | The signal aborted. The process is stopped first.                                                                                                                                                           |
| `<name> exited (<exit code or signal>): <stderr>` | A coprocess ended. `exited()` settles with it, and each `receive` rejects with it (from `@zukhruf/coprocess`).                                                                                              |
| `<name> gave a line that is not JSON`             | A coprocess wrote a line that `JSON.parse` refuses. Only the `receive` of that line fails (from `@zukhruf/coprocess`).                                                                                      |

A non-zero exit code of a run is not an error.

## What the package does not do

- **A shell.** It starts a file with arguments, never a command line through a shell, so no argument is read by a shell. zx's `$` is a shell language; this is not.
- **A process that outlives this program.** Start it detached with `node:child_process` and unref it.
- **A pool of processes.** That is `@zukhruf/pool`, which keeps started processes.
- **Retries.** A caller that retries a run calls `run()` of its command again.
- **Later, on the map:** a ready wait for a listening port and for HTTP; the end with the parent through job objects on Windows; a pseudo-terminal; the resource usage of a run; a first stop signal other than SIGTERM.

## Who uses it

| Consumer                                                                                                                       | How                                                               | Record             |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------ |
| `@zukhruf/pool` workers, elt `VisionWorker` and `TranscriptionWorker`                                                          | `Coprocess`, today from `@zukhruf/coprocess`                      | coprocess ADR 0001 |
| the tests of mutex, single-flight and election                                                                                 | `NodeCommand`, today `startWorker` of `@zukhruf/testing/process`  | testing ADR 0021   |
| shipped code of git-hooks, nx, ssh, tcc, mteb, sqlite-open, the tools                                                          | `Command#run` and `Command#start`, today `node:child_process`     | backlog #6077      |
| the `sshd.ts` copies of docker, ssh and testing                                                                                | `Command#start` with a socket as stdio, and the stop of the group | backlog #6077      |
| `runNode` of sdk-it, `cli` and `started` of context-compiler, `run` of text2sql, `collectOutput` of deepagents, `shell` of elt | `Command#run`, `Command#start`, `NodeCommand#run`                 | backlog #6077      |

## The same concepts in other systems

| Concept                          | Other systems                                                                                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A run and its end as a value     | .NET 11 `Process.RunAndCaptureTextAsync` and `ProcessExitStatus`, Python `subprocess.run` and `CompletedProcess`, Go `Cmd.Output`, Deno `Command.output()`, Rust `Command::output` |
| A started process                | .NET `Process.Start`, Python `Popen`, Go `Cmd.Start`, Deno `Command.spawn()`, Rust `Command::spawn`                                                                                |
| The step from SIGTERM to SIGKILL | Go `Cmd.Cancel` and `WaitDelay`, CliWrap's graceful and forceful tokens, execa `forceKillAfterDelay`, Kubernetes `terminationGracePeriodSeconds`, systemd `TimeoutStopSec`         |
| The end with the parent          | .NET 11 `ProcessStartInfo.KillOnParentExit` (Windows, Linux), Go `SysProcAttr.Pdeathsig` (Linux)                                                                                   |
| Ready                            | Testcontainers `waitingFor` (log message, listening port, HTTP, health check)                                                                                                      |
| A disposal that stops            | Deno `ChildProcess[Symbol.asyncDispose]`, tokio `kill_on_drop`                                                                                                                     |
| A coprocess                      | bash `coproc`, ksh `\|&`                                                                                                                                                           |

## Why not a package of npm

The probes of 2026-11-27 are in [ADR 0008](./docs/adr/0008-execa-starts-the-process-and-keeps-its-output-and-the-package-stops-it-and-reads-its-lines-and-messages.md). No candidate (execa 10.2.1, nano-spawn 3.0.0, tinyexec 1.4.0, zx 8.8.5) ends a child with its parent at a SIGKILL, and none has a disposal. execa does the start and the stop, and this package uses it for them.

## API

```ts
import type { ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';
import type { Writable } from 'node:stream';

import type { Clock } from '@zukhruf/async';

/** The whole environment of the process. A value of undefined is left out. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** How a process ended: an exit code, or the signal that ended it. */
export type End =
  | { readonly exitCode: number; readonly signal?: undefined }
  | { readonly signal: NodeJS.Signals; readonly exitCode?: undefined };

export interface Output {
  readonly stdout: string;
  readonly stderr: string;
  /** stdout and stderr in the order that the process wrote them. */
  readonly output: string;
}

export type Completed = End & Output;

export interface CommandOptions {
  /** The whole environment of the process. */
  readonly env: Environment;
  /** Runs the grace (root ADR 0004). An app gives globalThis. */
  readonly clock: Clock;
  readonly cwd?: string;
  /** Milliseconds from SIGTERM to SIGKILL. Default 5000. */
  readonly grace?: number;
  /** Names the process in each error. Default: the file. */
  readonly name?: string;
}

export interface RunOptions {
  /** Written to stdin, and then stdin ends. */
  readonly input?: string | Uint8Array;
  /** An abort stops the process and rejects with the reason. */
  readonly signal?: AbortSignal;
}

interface Starting {
  readonly signal?: AbortSignal;
  readonly stderr?: 'pipe' | 'ignore';
}

/** The default: stdin and stdout piped. Only this start gives a piped process. */
export type PipedStartOptions = Starting & {
  readonly stdin?: 'pipe';
  readonly stdout?: 'pipe';
  readonly ready?: { readonly line: string | RegExp };
};

export type StartOptions =
  | PipedStartOptions
  | (Starting & {
      readonly stdin: 'ignore' | Socket;
      readonly stdout?: 'pipe';
      readonly ready?: { readonly line: string | RegExp };
    })
  | (Starting & {
      readonly stdin?: 'pipe' | 'ignore' | Socket;
      readonly stdout: 'ignore' | Socket;
      readonly ready?: never;
    });

/** What to run. It starts nothing until run() or start(). */
export class Command {
  constructor(file: string, args: readonly string[], options: CommandOptions);
  readonly file: string;
  readonly args: readonly string[];
  run(options?: RunOptions): Promise<Completed>;
  start(options?: PipedStartOptions): Promise<PipedProcess>;
  start(options: StartOptions): Promise<Process>;
}

/** A started process. Only start() of a command gives one. */
export interface Process extends AsyncDisposable {
  readonly name: string;
  readonly pid: number;
  /** null when stdin is 'ignore' or a socket. */
  readonly stdin: Writable | null;
  /** Settles once, with the end. */
  readonly ended: Promise<End>;
  /** The lines of stdout from the first one, also those before the call. */
  lines(): AsyncIterable<string>;
  /** The last 16 384 characters of stderr. */
  stderrTail(): string;
  /** SIGTERM to the group, SIGKILL to the group after the grace. */
  stop(): Promise<End>;
}

/** A started process with its stdin and stdout piped. */
export interface PipedProcess extends Process {
  readonly stdin: Writable;
}

export interface Message {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** A type, or a function that selects a message. */
export type MessageMatch = string | ((message: Message) => boolean);

export interface NodeCommandOptions extends CommandOptions {
  /** Node.js flags before the source. */
  readonly nodeOptions?: readonly string[];
}

export interface NodeStartOptions extends Starting {
  /** Gets the child before it can send, for example to join it to a coordinator. */
  readonly admit?: (child: ChildProcess) => void;
  readonly ready?:
    { readonly line: string | RegExp } | { readonly message: MessageMatch };
}

/** JavaScript source to run as a module in its own Node.js, with an IPC channel. */
export class NodeCommand {
  constructor(source: string, options: NodeCommandOptions);
  run(options?: RunOptions): Promise<Completed>;
  start(options?: NodeStartOptions): Promise<NodeProcess>;
}

export interface NodeProcess extends AsyncDisposable {
  readonly process: PipedProcess;
  /** Each message so far, in order. */
  readonly messages: readonly Message[];
  send(message: Message): void;
  next(
    match: MessageMatch,
    options: { readonly signal: AbortSignal },
  ): Promise<Message>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** The JSON-lines view of a started process. */
export class Coprocess implements AsyncDisposable {
  constructor(process: PipedProcess);
  readonly process: PipedProcess;
  send(value: unknown): void;
  receive(): Promise<unknown>;
  request(value: unknown): Promise<unknown>;
  /** Settles once, with the error that each later receive gets. */
  exited(): Promise<Error>;
  /** Ends stdin and waits for the end. */
  close(): Promise<End>;
  [Symbol.asyncDispose](): Promise<void>;
}

export class StartError extends Error {}

export class EndedBeforeReadyError extends Error {
  readonly end: End;
  /** The stderr tail. */
  readonly stderr: string;
}
```

## Documentation

- The glossary: [CONTEXT.md](./CONTEXT.md).
- The decisions: [docs/adr](./docs/adr).
