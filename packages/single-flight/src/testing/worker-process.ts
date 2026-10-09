import { type ChildProcess, spawn } from 'node:child_process';

import { isRecord } from '../shared/is-record.ts';

export interface WorkerMessage {
  type: string;
  [field: string]: unknown;
}

export interface WorkerProcess extends AsyncDisposable {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  readonly messages: WorkerMessage[];
  stderr: string;
  has(type: string): boolean;
}

const isWorkerMessage = (message: unknown): message is WorkerMessage =>
  isRecord(message) && typeof message.type === 'string';

/**
 * Runs `source` as an ES module in its own Node process, with `name` as
 * argv[1] and an IPC channel back to this process. Disposing kills it.
 */
export function startWorker(source: string, name: string): WorkerProcess {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', source, name],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  const closed = Promise.withResolvers<void>();
  const worker: WorkerProcess = {
    child,
    closed: closed.promise,
    messages: [],
    stderr: '',
    has(type: string) {
      return worker.messages.some((message) => message.type === type);
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
  child.once('close', () => closed.resolve());
  child.on('message', (message) => {
    if (isWorkerMessage(message)) worker.messages.push(message);
  });
  return worker;
}
