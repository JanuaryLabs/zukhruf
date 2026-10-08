import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { isRecord } from '../flight-records.ts';

/** What a caller process says about its run. */
export type Message =
  | { readonly type: 'flying' }
  | { readonly type: 'joined' }
  | {
      readonly type: 'landed';
      readonly value: string;
      readonly joined: boolean;
    }
  | {
      readonly type: 'failed';
      readonly name: string;
      readonly message: string;
    };

/** How the work of a caller process ends, when that process leads the flight. */
export type Order =
  | { readonly type: 'land'; readonly value: string }
  | {
      readonly type: 'crash';
      readonly name: string;
      readonly message: string;
      readonly code: string;
    };

export function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false;
  switch (value['type']) {
    case 'flying':
    case 'joined':
      return true;
    case 'landed':
      return (
        typeof value['value'] === 'string' &&
        typeof value['joined'] === 'boolean'
      );
    case 'failed':
      return (
        typeof value['name'] === 'string' &&
        typeof value['message'] === 'string'
      );
    default:
      return false;
  }
}

export function isOrder(value: unknown): value is Order {
  if (!isRecord(value)) return false;
  switch (value['type']) {
    case 'land':
      return typeof value['value'] === 'string';
    case 'crash':
      return ['name', 'message', 'code'].every(
        (field) => typeof value[field] === 'string',
      );
    default:
      return false;
  }
}

/** How long a test waits for a caller process to say something. Starting Node and loading the sources takes most of it. */
const patience = 10_000;

export interface CallerProcess extends AsyncDisposable {
  /** The first message of `type` from the caller, at once if it came already. */
  heard(type: Message['type']): Promise<Message>;
  order(order: Order): void;
  /** Stops the process at once, as a crash does, and waits until it is gone. */
  kill(): Promise<void>;
}

/**
 * A caller of `SharedFlight` in a process of its own, for the key `sync`. Its
 * records and its locks are in two directories, which callers in other
 * processes share.
 */
export function startCaller(records: string, locks: string): CallerProcess {
  const child = fork(
    fileURLToPath(new URL('./caller.fixture.ts', import.meta.url)),
    [records, locks],
    // The test runner's flags would make the child a test file too.
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  const messages: Message[] = [];
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('message', (message) => {
    if (isMessage(message)) messages.push(message);
  });

  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await closed;
  };
  return {
    async heard(type: Message['type']) {
      const signal = AbortSignal.timeout(patience);
      for (;;) {
        const found = messages.find((message) => message.type === type);
        if (found) return found;
        try {
          await once(child, 'message', { signal });
        } catch (error) {
          throw new Error(
            `The caller never said "${type}". It said ${JSON.stringify(messages)}. Its stderr: ${stderr}`,
            { cause: error },
          );
        }
      }
    },
    order(order: Order) {
      child.send(order);
    },
    kill,
    [Symbol.asyncDispose]: kill,
  };
}
