import type { ChildProcess } from 'node:child_process';
import type { Worker } from 'node:worker_threads';
import { LockFileStore } from '../lock-stores/file-system/lock-file-store.ts';
import { TicketQueueFileStore } from '../lock-stores/file-system/ticket-queue-file-store.ts';
import { IpcLockCoordinator } from '../lock-stores/ipc/ipc-lock-coordinator.ts';
import { IpcStore } from '../lock-stores/ipc/ipc-store.ts';
import { MemoryStore } from '../lock-stores/memory/memory-store.ts';
import { SocketStore } from '../lock-stores/socket/socket-store.ts';
import { SqliteStore } from '../lock-stores/sqlite/sqlite-store.ts';
import { ThreadLockCoordinator } from '../lock-stores/thread/thread-lock-coordinator.ts';
import { ThreadStore } from '../lock-stores/thread/thread-store.ts';
import type { LockStore } from '../mutex/lock-store.ts';

const pollInterval = 10;

/** How long a waiting caller is given to (wrongly) enter an occupied lock. */
export const settle = pollInterval * 5;

/** A new lock-server leader grants nothing for this long after a failover. */
export const graceWindow = 200;

/**
 * Who can share a store's locks: one store instance, the threads of one
 * process, a parent and the children it spawned, or every process on the host.
 */
export type Reach = 'instance' | 'process' | 'process-tree' | 'host';

/** A store built in this thread, plus how children and workers started from here join it. */
export interface StoreHost extends AsyncDisposable {
	store: LockStore;
	adoptProcess(child: ChildProcess): void;
	adoptThread(worker: Worker): void;
}

export interface StoreCase {
	name: string;
	reach: Reach;
	/** Whether a new store over the same directory keeps issuing newer tokens. */
	durableTokens: boolean;
	/** Stores opened over the same directory share locks. */
	open(directory: string): StoreHost;
	/**
	 * Builds the store that a child process started by a host uses. It shares
	 * locks with the host only when the reach includes that child.
	 */
	openInChild?(directory: string): LockStore;
	/** Builds the store inside a worker thread that a host started and adopted. */
	openInThread?(directory: string): LockStore;
}

/** A store that every participant builds the same way, with nothing to adopt. */
function sharedByDirectory(create: (directory: string) => LockStore) {
	return {
		open: (directory: string): StoreHost => {
			const store = create(directory);
			return {
				store,
				adoptProcess() {},
				adoptThread() {},
				async [Symbol.asyncDispose]() {
					if (Symbol.asyncDispose in store) {
						await (store as LockStore & AsyncDisposable)[Symbol.asyncDispose]();
					}
				},
			};
		},
		openInChild: create,
		openInThread: create,
	};
}

export const storeCases: StoreCase[] = [
	{
		name: 'MemoryStore',
		reach: 'instance',
		durableTokens: false,
		open: () => ({
			store: new MemoryStore(),
			adoptProcess() {},
			adoptThread() {},
			async [Symbol.asyncDispose]() {},
		}),
		openInChild: () => new MemoryStore(),
	},
	{
		name: 'ThreadStore',
		reach: 'process',
		durableTokens: false,
		open: () => {
			const coordinator = new ThreadLockCoordinator();
			return {
				store: coordinator,
				adoptProcess() {},
				adoptThread: (worker) => coordinator.adopt(worker),
				async [Symbol.asyncDispose]() {},
			};
		},
		// In a child process of its own, the child's main thread is the coordinator.
		openInChild: () => new ThreadLockCoordinator(),
		openInThread: () => new ThreadStore(),
	},
	{
		name: 'IpcStore',
		reach: 'process-tree',
		durableTokens: false,
		open: () => {
			const coordinator = new IpcLockCoordinator();
			return {
				store: coordinator,
				adoptProcess: (child) => coordinator.adopt(child),
				adoptThread() {},
				async [Symbol.asyncDispose]() {},
			};
		},
		openInChild: () => new IpcStore(),
	},
	{
		name: 'TicketQueueFileStore',
		reach: 'host',
		durableTokens: true,
		...sharedByDirectory(
			(directory) => new TicketQueueFileStore(directory, { pollInterval }),
		),
	},
	{
		name: 'LockFileStore',
		reach: 'host',
		durableTokens: true,
		...sharedByDirectory(
			(directory) => new LockFileStore(directory, { pollInterval }),
		),
	},
	{
		name: 'SqliteStore',
		reach: 'host',
		durableTokens: true,
		...sharedByDirectory(
			(directory) => new SqliteStore(directory, { pollInterval }),
		),
	},
	{
		name: 'SocketStore',
		reach: 'host',
		durableTokens: true,
		...sharedByDirectory(
			(directory) => new SocketStore(directory, { pollInterval, graceWindow }),
		),
	},
];

function storeCase(name: string): StoreCase {
	const store = storeCases.find((candidate) => candidate.name === name);
	if (!store) throw new Error(`Unknown store ${JSON.stringify(name)}`);
	return store;
}

/** For child processes that a host started and adopted. */
export function createChildStore(name: string, directory: string): LockStore {
	const openInChild = storeCase(name).openInChild;
	if (!openInChild) throw new Error(`${name} cannot be shared with child processes`);
	return openInChild(directory);
}

/** For worker threads that a host started and adopted. */
export function createThreadStore(name: string, directory: string): LockStore {
	const openInThread = storeCase(name).openInThread;
	if (!openInThread) throw new Error(`${name} cannot be shared with worker threads`);
	return openInThread(directory);
}
