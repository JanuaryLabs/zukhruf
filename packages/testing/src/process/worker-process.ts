import { type ChildProcess, spawn } from 'node:child_process';

import { untilAborted } from '@zukhruf/async';

export interface WorkerMessage {
  type: string;
  [field: string]: unknown;
}

/** Selects a message: its `type`, or a predicate over the whole message. */
export type MessageMatch = string | ((message: WorkerMessage) => boolean);

export interface WorkerProcess extends AsyncDisposable {
  readonly child: ChildProcess;
  /** Resolves when the child exited and closed its pipes. */
  readonly closed: Promise<void>;
  /** Each message the child sent, in order. */
  readonly messages: WorkerMessage[];
  /** The child's stderr, each chunk prefixed with the worker's name. */
  stderr: string;
  /** How the child exited, or `null` while it runs. */
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  has(type: string): boolean;
  find(type: string): WorkerMessage | undefined;
  /**
   * The first message that `match` selects, sent before or after the call.
   * A predicate sees each message once, in the order the child sent it, so it
   * can count. Rejects with the child's stderr when the child closes first,
   * and with the reason of `signal` when it aborts.
   */
  next(
    match: MessageMatch,
    options: { signal: AbortSignal },
  ): Promise<WorkerMessage>;
}

export interface WorkerOptions {
  /** Runs with the child before it can send anything, for example to join it to a coordinator. */
  admit?: (child: ChildProcess) => void;
  /** Node flags before `--eval`. */
  nodeOptions?: string[];
}

const isWorkerMessage = (message: unknown): message is WorkerMessage =>
  typeof message === 'object' &&
  message !== null &&
  'type' in message &&
  typeof message.type === 'string';

/**
 * Ends the child when this process ends, even by SIGKILL: the OS closes the
 * write end of the child's stdin, and the child reads its end. A `disconnect`
 * listener on the IPC channel would keep each child alive until its parent
 * ends, and an unref of the channel would let a child exit while it waits for
 * a message of the parent. The unref stdin keeps nothing alive. ESM hoists the
 * imports of `source` above it.
 */
const exitWithParent =
  "process.stdin.once('end', () => process.exit(1)).resume().unref();\n";

/**
 * Runs `source` as an ES module in its own Node process, with `name` as
 * argv[1] and an IPC channel back to this process. Disposing kills it, and
 * the child exits when this process ends.
 */
export function startWorker(
  source: string,
  name: string,
  { admit, nodeOptions = [] }: WorkerOptions = {},
): WorkerProcess {
  const child = spawn(
    process.execPath,
    [
      ...nodeOptions,
      '--input-type=module',
      '--eval',
      exitWithParent + source,
      name,
    ],
    { stdio: ['pipe', 'ignore', 'pipe', 'ipc'] },
  );
  admit?.(child);
  const closed = Promise.withResolvers<void>();
  const worker: WorkerProcess = {
    child,
    closed: closed.promise,
    messages: [],
    stderr: '',
    exit: null,
    has(type) {
      return worker.messages.some((message) => message.type === type);
    },
    find(type) {
      return worker.messages.find((message) => message.type === type);
    },
    next(match, { signal }) {
      const selects =
        typeof match === 'string'
          ? (message: WorkerMessage) => message.type === match
          : match;
      const arrived = worker.messages.find(selects);
      if (arrived) return Promise.resolve(arrived);
      const message = Promise.withResolvers<WorkerMessage>();
      const onMessage = (sent: unknown) => {
        if (!isWorkerMessage(sent) || !selects(sent)) return;
        child.off('message', onMessage);
        message.resolve(sent);
      };
      child.on('message', onMessage);
      void closed.promise.then(() =>
        message.reject(
          new Error(
            `${name} closed with ${JSON.stringify(worker.exit)} before it sent ${typeof match === 'string' ? `'${match}'` : 'a selected message'}.\n${worker.stderr}`,
          ),
        ),
      );
      return untilAborted(message.promise, signal).finally(() =>
        child.off('message', onMessage),
      );
    },
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await closed.promise;
    },
  };
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    worker.stderr += `${name}: ${chunk}`;
  });
  child.once('error', (error) => {
    worker.stderr += `${name}: ${error.message}\n`;
  });
  child.once('close', (code, signal) => {
    worker.exit = { code, signal };
    closed.resolve();
  });
  child.on('message', (message) => {
    if (isWorkerMessage(message)) worker.messages.push(message);
  });
  return worker;
}
