import { parentPort, type MessagePort } from 'node:worker_threads';
import type { Lease } from '../../mutex/lease.ts';
import type { LockStore } from '../../mutex/lock-store.ts';
import type { ClientConnection, Connector } from '../remote/connector.ts';
import { RemoteLockClient } from '../remote/remote-lock-client.ts';
import { ParentPortConnection } from './parent-port-connection.ts';

/** A worker has one port to its parent thread for its whole life. */
class ParentPortConnector implements Connector {
	readonly #port: MessagePort;
	#handedOut = false;

	constructor(port: MessagePort) {
		this.#port = port;
	}

	async connect(): Promise<ClientConnection | undefined> {
		if (this.#handedOut) return undefined;
		this.#handedOut = true;
		return new ParentPortConnection(this.#port);
	}
}

/**
 * The worker-thread side of `ThreadLockCoordinator`: asks the thread that
 * started this worker for keys, through the worker's message port.
 */
export class ThreadStore implements LockStore {
	readonly #client: RemoteLockClient;

	constructor() {
		if (!parentPort) {
			throw new Error(
				'ThreadStore runs in a worker thread; use ThreadLockCoordinator in the thread that starts the workers.',
			);
		}
		this.#client = new RemoteLockClient(new ParentPortConnector(parentPort));
	}

	acquire(key: string): Promise<Lease> {
		return this.#client.acquire(key);
	}
}
