import type { ChildProcess } from 'node:child_process';
import type { Worker } from 'node:worker_threads';

import type { LockStore } from '../../mutex/lock-store.ts';

/** The xUnit test fixture of a lock store: what each store over it shares. */
export interface Fixture extends AsyncDisposable {
  /** Where the stores of this fixture are opened; a child or a thread gets it as text. */
  readonly location: string;
}

/** A lock store open in this thread. */
export interface Host extends AsyncDisposable {
  readonly store: LockStore;
}

/** A module that a new process or thread imports to build its store. */
export interface StoreModule {
  readonly url: URL;
  /** The name of an export `(location: string) => LockStore`. */
  readonly export: string;
}

/** How a new Node process builds the store for an app of its own, and how the host lets that process in. */
export interface ProcessSide<H extends Host> {
  readonly module: StoreModule;
  /** Joins `child` to `host` before the child asks for a key. */
  admit(host: H, child: ChildProcess): void;
}

/** A lock store as the lock-store contract drives it. */
export interface Subject<H extends Host = Host> {
  /** The class name, in the title of each suite. */
  readonly name: string;
  /** Makes a new fixture; a server-backed one finds its Docker engine through `environment`. */
  fixture(environment: NodeJS.ProcessEnv): Promise<Fixture>;
  /** Opens a store over `location`. */
  open(location: string): H;
  readonly process: ProcessSide<H>;
  /** Milliseconds: the upper bound of one grant and its release with no contention, on the local server or engine. */
  readonly grantLatency: number;
  /** Milliseconds: the upper bound from the close of a holder process until a look sees no holder. */
  readonly releaseLatency: number;
}

const shares = Symbol('shares');

/** A process side whose child shares locks with its host over one fixture. */
export interface SharedByProcesses<H extends Host> extends ProcessSide<H> {
  readonly [shares]: 'processes';
}

/** How a worker thread builds a store that shares locks with its host, and how the host lets the worker in. */
export interface SharedByThreads<H extends Host> {
  readonly module: StoreModule;
  /** Joins `worker` to `host` before the worker asks for a key. */
  admit(host: H, worker: Worker): void;
  readonly [shares]: 'threads';
}

/** The lock directory of a host lock store: the location of each fixture is that directory. */
export interface OnDisk<H extends Host> {
  /** Opens a store over `directory`, which may not exist yet. */
  openIn(directory: string): H;
}

/** Declares that the child of `side` shares locks with its host. */
export function sharesWithProcesses<H extends Host>(
  side: ProcessSide<H>,
): SharedByProcesses<H> {
  return { ...side, [shares]: 'processes' };
}

/** Declares that a worker thread built from `side` shares locks with its host. */
export function sharesWithThreads<H extends Host>(side: {
  module: StoreModule;
  admit(host: H, worker: Worker): void;
}): SharedByThreads<H> {
  return { ...side, [shares]: 'threads' };
}

/** The fixture of a store that keeps its locks in the memory of its own process or thread. */
export async function inMemory(): Promise<Fixture> {
  return { location: '', async [Symbol.asyncDispose]() {} };
}
