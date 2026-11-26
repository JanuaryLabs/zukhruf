import { randomBytes, randomUUID } from 'node:crypto';

import {
  type Container,
  ContainerNotFoundError,
  ContainerNotRunningError,
} from '@zukhruf/docker';

import { succeeded } from './succeeded.ts';

/** The kind of a database fixture's shared server: it names the collector of the server. */
export const KIND_LABEL = 'dev.zukhruf.testing.kind';

export type Kind = 'postgres' | 'mysql' | 'mariadb' | 'sqlserver';

const hex = (runId: string): string => runId.replaceAll('-', '');

/**
 * The name of a database that `database()` creates. In a run, the name holds
 * the run's id, its owner reference (ADR 0011).
 */
export const databaseName = (id: string | undefined): string =>
  id
    ? `test_${hex(id)}_${randomBytes(8).toHex()}`
    : `test_${hex(randomUUID())}`;

/**
 * The databases of one server kind, through the client in the server's
 * image. Disposal and the reaper (ADR 0020) both run its command and SQL.
 */
export interface Collector {
  readonly kind: Kind;
  /** The variable of the server's `Config.Env` that holds the client's credential, and the credential without it. */
  readonly credential: { variable: string; fallback?: string };
  /** The command in the server's container that runs `sql` with `credential`, and prints one value of each row a line. */
  command(credential: string, sql: string): string[];
  /** The SQL that drops the database `name` if it exists. */
  drop(name: string): string;
}

/** The states of a server that took its databases with it: a shared server runs with AutoRemove. */
export const ENDED: ReadonlySet<string> = new Set([
  'exited',
  'dead',
  'removing',
]);

/**
 * Drops the database `name` in the server `container` with the client of
 * `collector`. A server that is gone or stopped took its databases with it:
 * that drop resolves. A paused server still holds them: that drop rejects.
 */
export async function dropDatabase(
  collector: Collector,
  container: Container,
  credential: string,
  name: string,
): Promise<void> {
  try {
    await succeeded(
      container,
      collector.command(credential, collector.drop(name)),
    );
  } catch (error) {
    if (error instanceof ContainerNotFoundError) return;
    if (error instanceof ContainerNotRunningError && ENDED.has(error.state))
      return;
    throw error;
  }
}
