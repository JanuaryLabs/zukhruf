# @zukhruf/json-lines-process

A long-lived child process that takes JSON values on stdin and gives JSON values on stdout, one value on each line. A native helper that keeps a model loaded, or a command-line agent that reads one message at a time, works this way. The class starts the process, sends and receives values, tells you when the process exits, and stops it with SIGTERM and then SIGKILL.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Send a request and receive the answer

A helper answers each request with one line. `request` sends a value and receives the next one.

```ts
import { JsonLinesProcess } from '@zukhruf/json-lines-process';

const ocr = new JsonLinesProcess('/path/to/vision-worker', [], {
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

`exited()` settles once, when the process ends, with the error that each later `receive` gets. A pool can listen to it and replace the worker at once.

```ts
void worker.exited().then(() => pool.replace(worker));
```

The error names the process, the exit code or signal, and the last 16 KiB of its stderr, for example `Vision worker exited (SIGKILL): <stderr>`. It does not contain the command line, because arguments can hold prompts or secrets.

## Stop the process

`kill()` sends SIGTERM. If the process is still alive after five seconds, it gets SIGKILL. A native helper without a signal handler stops at once; a process that saves its state first gets the time to do it. `close()` ends stdin, which asks the process to finish, and waits for the exit.

## Decisions

- [ADR 0001](./docs/adr/0001-the-exit-is-an-event-and-the-package-uses-execa.md): the exit is an event, and the package uses execa.
