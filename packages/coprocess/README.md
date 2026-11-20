# @zukhruf/coprocess

A coprocess is a long-lived child process that the parent talks to over its stdin and stdout, as with `coproc` in bash and `|&` in ksh. A native helper that keeps a model loaded, or a command-line agent that reads one message at a time, is a coprocess. `Coprocess` starts the process, sends and receives values, tells you when the process exits, and stops it with SIGTERM and then SIGKILL. A value is JSON on one line; that is the only framing so far.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/coprocess
```

`new Coprocess(file, args, options)` starts the process at once. `name` names the process in the errors. `cwd` and `env` go to execa: `cwd` is the folder the process starts in, and `env` adds to the environment of the parent, because execa's `extendEnv` is `true` by default ([execa options](https://github.com/sindresorhus/execa/blob/main/docs/api.md#optionsenv)).

```ts
import { Coprocess } from '@zukhruf/coprocess';

const helper = new Coprocess('./helper', ['--json'], {
  name: 'Helper',
  cwd: '/path/to/helper',
  env: { LOG_LEVEL: 'error' },
});
const answer = await helper.request({ ping: true });
await helper.close();
```

## Send a request and receive the answer

A helper answers each request with one line. `request` sends a value and receives the next one.

```ts
import { Coprocess } from '@zukhruf/coprocess';

const ocr = new Coprocess('/path/to/vision-worker', [], {
  name: 'Vision worker',
});
const answer = await ocr.request({ path: '/tmp/receipt.png' });
await ocr.close();
```

The process gives `unknown`. Parse it with your own schema, for example with zod.

## Receive many values for one message

An agent can answer one message with many lines, and a last line that says the work is done. Use `send` once and `receive` until that line comes.

```ts
claude.send({ type: 'user', message: { role: 'user', content: prompt } });
let event = await claude.receive();
while (!isResult(event)) event = await claude.receive();
```

## Know when the process exits

`exited()` settles once, when the process ends, with the error that each later `receive` gets. `@zukhruf/pool` listens to `exited()` of each worker itself, through its `Worker` interface, so a worker class that keeps a `Coprocess` gives its `exited()` to the pool and does not tell the pool of the exit (`packages/pool/src/worker.ts`, `packages/pool/src/slots.ts`).

The error names the process, the exit code or signal, and the last 16 KiB of its stderr, for example `Vision worker exited (SIGKILL): <stderr>`. It does not contain the command line, because arguments can hold prompts or secrets.

## Stop the process

`kill()` sends SIGTERM. If the process is still alive after five seconds, it gets SIGKILL. A native helper without a signal handler stops at once; a process that saves its state first gets the time to do it. `close()` ends stdin, which asks the process to finish, and waits for the exit.

## Errors

Each error is an `Error`. Its message tells the cases apart.

| Error                                             | When                                                                                                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<name> exited (<exit code or signal>): <stderr>` | The process exited. `exited()` settles with this error, the `receive` that waits rejects with it, and each later `receive` rejects with it too (`src/coprocess.test.ts`).                                            |
| `<name> gave a line that is not JSON`             | The process gave a line that `JSON.parse` refuses. Only the `receive` of that line fails; its `cause` is the error of `JSON.parse` (`src/coprocess.test.ts`).                                                        |
| `<name> could not start`                          | execa could not start the process, for example because the file does not exist. `exited()` settles with this error, and each `receive` rejects with it; its `cause` is the error of execa (`src/coprocess.test.ts`). |

## API

```ts
interface CoprocessOptions extends Pick<Options, 'cwd' | 'env'> {
  readonly name: string; // names the process in the errors
}

class Coprocess {
  constructor(file: string, args: readonly string[], options: CoprocessOptions);
  exited(): Promise<Error>;
  send(value: unknown): void;
  receive(): Promise<unknown>;
  request(value: unknown): Promise<unknown>;
  kill(): void;
  close(): Promise<void>;
}
```

`Options` is the options type of execa.

## Decisions

- [ADR 0001](./docs/adr/0001-the-exit-is-an-event-and-the-package-uses-execa.md): the exit is an event, and the package uses execa.
