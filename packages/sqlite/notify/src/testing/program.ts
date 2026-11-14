import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { open } from '@zukhruf/sqlite-open';
import { settleWithin } from '@zukhruf/testing/async';

import type { Notification, Notifications } from '../index.ts';

/** How long a test waits for a fact of real I/O, never asserting that it came sooner. */
export const factTimeout = 10_000;

/** The package index, for a program's `import`. */
const packageIndex = new URL('../index.ts', import.meta.url).href;

/** What a program printed: one JSON object a line. */
export type Printed = Record<string, unknown> & { readonly event: string };

/** What a program does: a JSON object a line on its standard input. */
export type Command =
  | { do: 'listen'; channel: string }
  | { do: 'unlisten'; channel: string }
  /** Sends `count` notifications, each in its own transaction; with `turns: 'microtask'` one a microtask, else all in one run of code. */
  | {
      do: 'notify';
      channel: string;
      payloads: string[];
      turns?: 'microtask';
    }
  /** Notifies and inserts a row of `jobs` in one transaction, then throws: the transaction rolls back. */
  | { do: 'roll back'; channel: string; payload: string }
  /** Notifies and inserts a row of `jobs` in one transaction; prints `committed`, or `failed` with the error. */
  | { do: 'notify with a job'; channel: string; payload: string }
  /** Notifies, then dies by SIGKILL before the microtask of the wakes. */
  | { do: 'notify and die'; channel: string; payload: string }
  /** Notifies, then stops reading its input and does not dispose, so only its own handles keep it alive. */
  | { do: 'notify and leave'; channel: string; payload: string }
  /** Notifies and disposes in the same run of code, before the microtask of the wakes. */
  | { do: 'notify and dispose'; channel: string; payload: string }
  /** Takes the write lock of the file in a BEGIN IMMEDIATE transaction; prints `locked`. */
  | { do: 'hold the write lock' }
  /** Commits that transaction; prints `released`. */
  | { do: 'release the write lock' }
  | { do: 'dispose' };

/** The source of a program that holds one `Notifications` on the file and obeys commands. */
function source(path: string, maxQueuedNotifications: number | undefined) {
  return `
import { createInterface } from 'node:readline';
import { Notifications } from ${JSON.stringify(packageIndex)};
import { WriteAheadLog, open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';

const print = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const database = open(${JSON.stringify(path)}, { journal: new WriteAheadLog({ synchronous: 'full' }) });
const notifications = new Notifications({ database, clock: globalThis, maxQueuedNotifications: ${String(maxQueuedNotifications)} });
database.exec('CREATE TABLE IF NOT EXISTS jobs (name TEXT NOT NULL) STRICT');
notifications.on('notification', (notification) => print({ event: 'notification', ...notification }));
notifications.on('error', (error) => print({ event: 'error', message: String(error) }));
const input = createInterface({ input: process.stdin });
const withJob = (command) => {
  database.prepare('INSERT INTO jobs VALUES (?)').run(command.payload);
  notifications.notify(command.channel, command.payload);
};
const commands = {
  async listen(command) { await notifications.listen(command.channel); print({ event: 'listened', channel: command.channel }); },
  async unlisten(command) { await notifications.unlisten(command.channel); print({ event: 'unlistened', channel: command.channel }); },
  async notify(command) {
    for (const payload of command.payloads) {
      notifications.notify(command.channel, payload);
      if (command.turns === 'microtask') await null;
    }
    print({ event: 'sent' });
  },
  async 'roll back'(command) {
    try {
      transaction(database, () => { withJob(command); throw new Error('roll back'); }, { mode: 'immediate' });
    } catch {}
    print({ event: 'rolled back' });
  },
  async 'notify with a job'(command) {
    try {
      transaction(database, () => withJob(command), { mode: 'immediate' });
      print({ event: 'committed' });
    } catch (error) {
      print({ event: 'failed', name: error.name, code: error.code, message: error.message });
    }
  },
  async 'notify and die'(command) {
    notifications.notify(command.channel, command.payload);
    process.kill(process.pid, 'SIGKILL');
  },
  async 'notify and leave'(command) {
    input.close();
    process.stdin.destroy();
    notifications.notify(command.channel, command.payload);
    print({ event: 'left' });
  },
  async 'notify and dispose'(command) {
    notifications.notify(command.channel, command.payload);
    await commands.dispose();
  },
  async 'hold the write lock'() {
    database.exec('BEGIN IMMEDIATE');
    print({ event: 'locked' });
  },
  async 'release the write lock'() {
    database.exec('COMMIT');
    print({ event: 'released' });
  },
  async dispose() {
    input.close();
    await notifications[Symbol.asyncDispose]();
    database.close();
    print({ event: 'disposed' });
  },
};
let chain = Promise.resolve();
input.on('line', (line) => {
  const command = JSON.parse(line);
  chain = chain.then(() => commands[command.do](command)).catch((error) => print({ event: 'error', message: String(error) }));
});
print({ event: 'ready' });
`;
}

export interface Program extends AsyncDisposable {
  readonly child: ChildProcess;
  readonly pid: number;
  /** Resolves with the exit code, or `null` when a signal ended the program. */
  readonly exited: Promise<number | null>;
  /** Everything the program printed so far. */
  readonly printed: readonly Printed[];
  /** The notifications that the program got so far. */
  readonly notifications: readonly Printed[];
  do(command: Command): void;
  /** Resolves with the first printed object, past or coming, that `match` accepts, within `factTimeout`. */
  printedOne(
    label: string,
    match: (printed: Printed) => boolean,
  ): Promise<Printed>;
  /** Resolves when the program got `count` notifications, within `factTimeout`. */
  heard(count: number): Promise<readonly Printed[]>;
}

export interface ProgramOptions {
  maxQueuedNotifications?: number;
}

/**
 * Runs a program with one `Notifications` on the file at `path`, in its own
 * Node process, and resolves when it is ready. Disposing ends it: a stopped
 * program is continued and disposed; a program that does not end in time is
 * killed, and the socket files of its listener rows are removed.
 */
export async function startProgram(
  path: string,
  options: ProgramOptions = {},
): Promise<Program> {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      source(path, options.maxQueuedNotifications),
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit').then(() => child.exitCode);
  const printed: Printed[] = [];
  const watchers = new Set<() => void>();
  createInterface({ input: child.stdout! }).on('line', (line) => {
    printed.push(JSON.parse(line));
    for (const watcher of watchers) watcher();
  });
  const until = <T>(label: string, check: () => T | undefined): Promise<T> => {
    const found = Promise.withResolvers<T>();
    const watcher = () => {
      const value = check();
      if (value !== undefined) found.resolve(value);
    };
    watchers.add(watcher);
    watcher();
    return settleWithin(found.promise, label, factTimeout).finally(() =>
      watchers.delete(watcher),
    );
  };
  const notifications = () =>
    printed.filter((value) => value.event === 'notification');
  const program: Program = {
    child,
    pid: child.pid!,
    exited,
    printed,
    get notifications() {
      return notifications();
    },
    do(command) {
      child.stdin!.write(`${JSON.stringify(command)}\n`);
    },
    printedOne(label, match) {
      return until(label, () => printed.find(match));
    },
    heard(count) {
      return until(`${count} notifications`, () => {
        const heard = notifications();
        return heard.length >= count ? heard : undefined;
      });
    },
    async [Symbol.asyncDispose]() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGCONT');
      program.do({ do: 'dispose' });
      try {
        await settleWithin(exited, 'the program exits', factTimeout);
      } catch {
        child.kill('SIGKILL');
        await exited;
        await removeSocketFiles(path, program.pid);
      }
    },
  };
  await program.printedOne(
    'the program is ready',
    (value) => value.event === 'ready',
  );
  return program;
}

/** The address of each listener row of the program with the process id. */
export function addressesOf(path: string, processId: number): string[] {
  using reader = open(path, { readOnly: true });
  return reader
    .prepare('SELECT address FROM zukhruf_notify_listener WHERE process_id = ?')
    .all(processId)
    .map((row) => String(row['address']));
}

async function removeSocketFiles(path: string, processId: number) {
  for (const address of addressesOf(path, processId))
    await rm(address, { force: true });
}

/** The notifications and errors that a `Notifications` of the test process gets. */
export interface Heard {
  readonly notifications: readonly Notification[];
  readonly errors: readonly unknown[];
  /** Resolves when `count` notifications came, within `factTimeout`. */
  count(count: number): Promise<readonly Notification[]>;
}

export function hear(notifications: Notifications): Heard {
  const heard: Notification[] = [];
  const errors: unknown[] = [];
  const watchers = new Set<() => void>();
  notifications.on('notification', (notification) => {
    heard.push(notification);
    for (const watcher of watchers) watcher();
  });
  notifications.on('error', (error) => errors.push(error));
  return {
    notifications: heard,
    errors,
    count(count) {
      const reached = Promise.withResolvers<readonly Notification[]>();
      const watcher = () => {
        if (heard.length >= count) reached.resolve(heard);
      };
      watchers.add(watcher);
      watcher();
      return settleWithin(
        reached.promise,
        `${count} notifications`,
        factTimeout,
      ).finally(() => watchers.delete(watcher));
    },
  };
}
