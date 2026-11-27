# @zukhruf/process

> **Design for review: no code yet.** The README, the glossary and the ADRs are the API on paper. Nothing is built before the maintainer approves them (backlog #6077).

Start a process of this machine and know how it ends. `Process.run` runs a command to its end and gives its exit code or signal and its output, with no throw at a non-zero exit. `Process.start` gives a started process: it resolves when the process is ready, it stops the process group with SIGTERM and then SIGKILL, and the process ends with its parent, also when the parent is killed. `Coprocess` talks to a started process in JSON lines, and `NodeProcess` runs JavaScript source in its own Node.js with messages.

The package replaces `@zukhruf/coprocess` and the `process` area of `@zukhruf/testing`, which move here ([ADR 0001](./docs/adr/0001-one-package-starts-a-process-for-a-run-and-for-a-started-process-and-coprocess-and-the-test-worker-move-into-it.md)).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/process
```

```ts
import { Process } from '@zukhruf/process';

const lint = await Process.run('npx', ['eslint', 'src'], { env: process.env });
if (lint.exitCode !== 0) console.error(lint.output);
```

## Run a command to its end

`Process.run(file, args, options)` resolves when the process has ended and its streams have closed. It gives the end and the output ([ADR 0002](./docs/adr/0002-a-run-gives-its-end-as-a-value-an-exit-code-or-a-signal-and-rejects-only-when-the-process-cannot-start-or-its-signal-aborts.md)).

```ts
const run = await Process.run('git', ['status', '--porcelain'], {
  env: process.env,
  cwd: repository,
});
// run.exitCode is 0, or run.signal names the signal that ended it.
// run.stdout, run.stderr, and run.output with both in the order written.
```

- The end is `{ exitCode }` or `{ signal }`. A non-zero exit code is a value, not a rejection.
- The text is not trimmed. `stdout` keeps its last newline.
- `input` goes to stdin, and then stdin ends. Without `input`, stdin ends at once.
- `env` is required, and it is the whole environment of the process. Write `env: process.env` to pass your own ([ADR 0003](./docs/adr/0003-the-environment-is-a-required-input-and-the-process-gets-only-what-the-caller-names.md)).
- An abort of `signal` stops the process and rejects with the reason of the signal.

## Start a process and wait until it is ready

`Process.start(file, args, options)` starts the process and resolves when it is ready: at the first line of stdout that `ready.line` names ([ADR 0006](./docs/adr/0006-a-started-process-is-ready-at-a-line-or-a-message-that-the-caller-names-and-an-end-before-it-rejects.md)). Without `ready`, it resolves after the start.

```ts
await using owner = await Process.start(process.execPath, ['owner.js', path], {
  name: 'owner',
  env: process.env,
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

- On Windows a process does not end yet with a parent that is killed. A job object, as .NET 11 uses, is on the map as later.
- `sh` cannot tell an exit code above 128 from a signal, so a process that exits with 130 ends as `{ signal: 'SIGINT' }`.
- A child of the process that leaves the group (`setsid`, `detached: true`) does not end with it.

## Stop a started process

`stop()` sends SIGTERM to the process group. When the group is still alive after the grace, 5 seconds unless the caller gives `grace`, it sends SIGKILL to the group. It resolves with the end ([ADR 0005](./docs/adr/0005-a-stop-sends-sigterm-to-the-process-group-and-sigkill-after-a-grace-of-5-seconds.md)). An abort of `signal` is a stop. The disposal (`await using`) is a stop that also waits until the streams have closed.

## Talk to a coprocess in JSON lines

`Coprocess.start(file, args, options)` starts a process that reads one JSON value on each line of stdin and writes one on each line of stdout. `request(value)` sends a value and receives the next one. `send` and `receive` do each half. `close()` ends stdin and waits for the end ([ADR 0007](./docs/adr/0007-json-lines-and-messages-are-views-of-a-started-process-and-only-a-node-process-has-messages.md)).

```ts
await using ocr = await Coprocess.start('/path/to/vision-worker', [], {
  name: 'Vision worker',
  env: process.env,
});
const answer = await ocr.request({ path: '/tmp/receipt.png' });
```

`exited()` settles once, with the error that each later `receive` gets, as in `@zukhruf/coprocess` today, and `coprocess.process` is the started process.

## Run JavaScript source in its own Node.js

`NodeProcess.start(source, options)` runs `source` as an ES module in a new Node.js, with an IPC channel back to this process. `next(match, { signal })` resolves with the first message that `match` selects, sent before or after the call: a `type`, or a function of the message. `send(message)` sends one. `ready` also takes `{ message }`. `NodeProcess.run(source, options)` runs the source to its end and gives what `Process.run` gives.

```ts
await using holder = await NodeProcess.start(
  `
  import { connect } from 'node:net';
  // ... take the lock, then:
  process.send({ type: 'held' });
  `,
  {
    name: 'holder',
    env: process.env,
    ready: { message: 'held' },
    signal: t.signal,
  },
);
```

Only a `NodeProcess` has messages, because only a Node.js child can use the channel.

## Errors

| Error                                             | When                                                                                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StartError`                                      | The process could not start, for example because the file does not exist. Its `cause` is the error of the start (`ENOENT`, `EACCES`). `Process.run`, `Process.start` and the views reject with it.          |
| `EndedBeforeReadyError`                           | A started process ended before it was ready. It has `end` and `stderr` (the stderr tail). Its message names the process and the end, never the command line, because arguments can hold prompts or secrets. |
| the reason of `signal`                            | The signal aborted. The process is stopped first.                                                                                                                                                           |
| `<name> exited (<exit code or signal>): <stderr>` | A coprocess ended. `exited()` settles with it, and each `receive` rejects with it (from `@zukhruf/coprocess`).                                                                                              |
| `<name> gave a line that is not JSON`             | A coprocess wrote a line that `JSON.parse` refuses. Only the `receive` of that line fails (from `@zukhruf/coprocess`).                                                                                      |

A non-zero exit code of a run is not an error.

## What the package does not do

- **A shell.** It starts a file with arguments, never a command line through a shell, so no argument is read by a shell. zx's `$` is a shell language; this is not.
- **A process that outlives this program.** Start it detached with `node:child_process` and unref it.
- **A pool of processes.** That is `@zukhruf/pool`, which keeps started processes.
- **Retries.** A caller that retries a run calls `Process.run` again.
- **Later, on the map:** a ready wait for a listening port and for HTTP; the end with the parent through job objects on Windows; a pseudo-terminal; the resource usage of a run; a first stop signal other than SIGTERM.

## Who uses it

| Consumer                                                                                                                       | How                                                               | Record             |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------ |
| `@zukhruf/pool` workers, elt `VisionWorker` and `TranscriptionWorker`                                                          | `Coprocess`, today from `@zukhruf/coprocess`                      | coprocess ADR 0001 |
| the tests of mutex, single-flight and election                                                                                 | `NodeProcess`, today `startWorker` of `@zukhruf/testing/process`  | testing ADR 0021   |
| shipped code of git-hooks, nx, ssh, tcc, mteb, sqlite-open, the tools                                                          | `Process.run` and `Process.start`, today `node:child_process`     | backlog #6077      |
| the `sshd.ts` copies of docker, ssh and testing                                                                                | `Process.start` with a socket as stdio, and the stop of the group | backlog #6077      |
| `runNode` of sdk-it, `cli` and `started` of context-compiler, `run` of text2sql, `collectOutput` of deepagents, `shell` of elt | `Process.run`, `Process.start`, `NodeProcess.run`                 | backlog #6077      |

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

export interface RunOptions {
  readonly env: Environment;
  readonly cwd?: string;
  /** Written to stdin, and then stdin ends. */
  readonly input?: string | Uint8Array;
  /** An abort stops the process and rejects with the reason. */
  readonly signal?: AbortSignal;
  /** Milliseconds from SIGTERM to SIGKILL. Default 5000. */
  readonly grace?: number;
}

interface Starting {
  /** Names the process in each error. */
  readonly name: string;
  readonly env: Environment;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly grace?: number;
  readonly stdin?: 'pipe' | 'ignore' | Socket;
  readonly stderr?: 'pipe' | 'ignore';
}

export type StartOptions = Starting &
  (
    | {
        readonly stdout?: 'pipe';
        readonly ready?: { readonly line: string | RegExp };
      }
    | { readonly stdout: 'ignore' | Socket; readonly ready?: never }
  );

export class Process implements AsyncDisposable {
  static run(
    file: string,
    args: readonly string[],
    options: RunOptions,
  ): Promise<Completed>;
  static start(
    file: string,
    args: readonly string[],
    options: StartOptions,
  ): Promise<Process>;
  readonly name: string;
  readonly pid: number;
  /** null when stdin is 'ignore' or a socket. */
  readonly stdin: Writable | null;
  /** Settles once, with the end. */
  readonly ended: Promise<End>;
  /** The lines of stdout from the first one, also those before the call. */
  lines(): AsyncIterable<string>;
  /** The last 16 KiB of stderr. */
  stderrTail(): string;
  /** SIGTERM to the group, SIGKILL to the group after the grace. */
  stop(): Promise<End>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Message {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** A type, or a function that selects a message. */
export type MessageMatch = string | ((message: Message) => boolean);

export type NodeStartOptions = Omit<Starting, 'stdin'> & {
  /** Node.js flags before the source. */
  readonly nodeOptions?: readonly string[];
  /** Gets the child before it can send, for example to join it to a coordinator. */
  readonly admit?: (child: ChildProcess) => void;
  readonly ready?:
    { readonly line: string | RegExp } | { readonly message: MessageMatch };
};

export class NodeProcess implements AsyncDisposable {
  static run(
    source: string,
    options: RunOptions & { readonly nodeOptions?: readonly string[] },
  ): Promise<Completed>;
  static start(source: string, options: NodeStartOptions): Promise<NodeProcess>;
  readonly process: Process;
  /** Each message so far, in order. */
  readonly messages: readonly Message[];
  send(message: Message): void;
  next(
    match: MessageMatch,
    options: { readonly signal: AbortSignal },
  ): Promise<Message>;
  [Symbol.asyncDispose](): Promise<void>;
}

export class Coprocess implements AsyncDisposable {
  static start(
    file: string,
    args: readonly string[],
    options: Omit<Starting, 'stdin'>,
  ): Promise<Coprocess>;
  readonly process: Process;
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
