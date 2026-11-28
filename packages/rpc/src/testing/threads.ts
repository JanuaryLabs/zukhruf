import { addAbortListener, once } from 'node:events';
import { Worker } from 'node:worker_threads';

import { untilAborted } from '@zukhruf/async';
import {
  NodeCommand,
  type NodeProcess,
  type NodeStartOptions,
} from '@zukhruf/process';

import { WorkerConnection } from '../channel/worker-connection.ts';
import { ConnectionSupervisor } from '../connection/connection-supervisor.ts';
import type { Connection } from '../connection/connection.ts';

const rpcUrl = new URL('../index.ts', import.meta.url);

/** The tag of every connection of the tests. */
export const tag = '@test';

/**
 * Worker source that runs `body` with `parentPort` and the package as `rpc`
 * in scope. Only dynamic imports, because an eval worker is CommonJS or ESM
 * depending on the process that starts it.
 */
function threadSource(body: string) {
  return `
	(async () => {
		const { parentPort } = await import('node:worker_threads');
		const rpc = await import(${JSON.stringify(rpcUrl.href)});
		${body}
	})();
`;
}

/**
 * Source, for a thread, that serves `target` on the port to its parent with
 * the checks `methods` and the error classes `classes`. The supervisor of the
 * port is `link`, for the source that follows.
 */
export function serving(target: string, methods: string, classes = '[]') {
  return `
		const connection = new rpc.ParentPortConnection(parentPort, { tag: ${JSON.stringify(tag)} });
		const link = new rpc.ConnectionSupervisor({ connect: async () => connection });
		new rpc.Server(${target}, { methods: ${methods}, errors: new rpc.ErrorCodec(${classes}) }).serve(link);
	`;
}

/** A supervisor of `connection` alone: once it is lost, the supervisor is unavailable. */
export function linkTo<Outgoing>(
  connection: Connection<Outgoing>,
): ConnectionSupervisor<Outgoing> {
  let given = false;
  return new ConnectionSupervisor({
    connect: async () => {
      if (given) return undefined;
      given = true;
      return connection;
    },
  });
}

/** A thread of `body`, terminated at the dispose if it still runs. */
export function startThread(body: string): Worker & AsyncDisposable {
  const worker = new Worker(threadSource(body), { eval: true });
  return Object.assign(worker, {
    async [Symbol.asyncDispose]() {
      await worker.terminate();
    },
  });
}

/**
 * A connector that starts a new thread of `body` for each connect, as a host
 * that restarts its engine does, and the threads it started. A connect after
 * `limit` threads waits until it is aborted.
 */
export function threadConnector<Outgoing>(body: string, limit = Infinity) {
  const threads: (Worker & AsyncDisposable)[] = [];
  return {
    threads,
    connector: {
      connect(signal: AbortSignal): Promise<Connection<Outgoing>> {
        signal.throwIfAborted();
        if (threads.length >= limit) {
          return new Promise((_, reject) => {
            addAbortListener(signal, () => reject(signal.reason));
          });
        }
        const thread = startThread(body);
        threads.push(thread);
        return Promise.resolve(new WorkerConnection<Outgoing>(thread, { tag }));
      },
    },
    async [Symbol.asyncDispose]() {
      await Promise.all(threads.map((thread) => thread[Symbol.asyncDispose]()));
    },
  };
}

/** The next message of `thread` that is the thread's own: an object outside the envelope of the tests. */
export async function report(
  thread: NodeJS.EventEmitter,
  signal: AbortSignal,
): Promise<object> {
  for (;;) {
    const [message]: unknown[] = await untilAborted(
      once(thread, 'message'),
      signal,
    );
    if (typeof message === 'object' && message !== null && !(tag in message))
      return message;
  }
}

/**
 * A child process that runs `body` with `client` in scope: a `Client` over
 * the IPC channel to this process, whose answers `answers` checks.
 */
export function startAsker(
  body: string,
  answers: string,
  options: NodeStartOptions,
): Promise<NodeProcess> {
  return new NodeCommand(
    `
		import { promisify } from 'node:util';
		import * as rpc from ${JSON.stringify(rpcUrl.href)};
		const channel = new rpc.ProcessChannelConnection(promisify(process.send).bind(process), { tag: ${JSON.stringify(tag)} });
		const client = new rpc.Client(new rpc.ConnectionSupervisor({ connect: async () => channel }), {
			errors: new rpc.ErrorCodec([]),
			answers: ${answers},
		});
		${body}
	`,
    { name: 'asker', env: process.env, clock: globalThis },
  ).start(options);
}
