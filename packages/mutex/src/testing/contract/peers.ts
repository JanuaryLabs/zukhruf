import { Worker } from 'node:worker_threads';

import type { Host, SharedByThreads, StoreModule } from './subject.ts';

const mutexUrl = new URL('../../mutex/mutex.ts', import.meta.url);

/** Source of an expression, for an async context, that builds the store of `module` over `location`. */
export const storeIn = (module: StoreModule, location: string) =>
  `(await import(${JSON.stringify(module.url.href)}))[${JSON.stringify(module.export)}](${JSON.stringify(location)})`;

/**
 * Worker source that builds the store of `module` over `location`, then runs
 * `body` with `mutex`, `parentPort` and `workerData` in scope. Only dynamic
 * imports, because an eval worker is CommonJS or ESM depending on the process
 * that starts it.
 */
export const threadSource = (
  module: StoreModule,
  location: string,
  body: string,
) => `
	(async () => {
		const { parentPort, workerData } = await import('node:worker_threads');
		const { Mutex } = await import(${JSON.stringify(mutexUrl.href)});
		const mutex = new Mutex(${storeIn(module, location)});
		${body}
	})();
`;

/** Starts a worker thread that `host` admits before it can ask for a key. */
export function startThread<H extends Host>(
  sharing: SharedByThreads<H>,
  host: H,
  source: string,
  workerData?: unknown,
) {
  const thread = new Worker(source, { eval: true, workerData });
  sharing.admit(host, thread);
  return thread;
}

/** Source of a child that builds the store of `module` over `location`, with `mutex` in scope. */
export const childPrelude = (module: StoreModule, location: string) => `
	import { Mutex } from ${JSON.stringify(mutexUrl.href)};

	const mutex = new Mutex(${storeIn(module, location)});
`;

/** Source of a child that holds 'report:daily' until it is killed, and sends 'entered' once it holds it. */
export const holderSource = (module: StoreModule, location: string) => `
	${childPrelude(module, location)}
	setInterval(() => {}, 1000);
	await mutex.acquire('report:daily', async () => {
		process.send({ type: 'entered' });
		await new Promise(() => {});
	});
`;
