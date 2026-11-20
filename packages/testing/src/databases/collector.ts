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
 * The extended regular expression of the names of the databases of the run
 * whose id without hyphens is `runHex`. `_` is a wildcard of SQL's LIKE, so
 * only this exact pattern proves a run's database.
 */
export const ownedNames = (runHex: string): string =>
  `^test_${runHex}_[0-9a-f]{16}$`;

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
  /** The SQL that lists each database whose name starts with `test`, a superset of a run's. */
  readonly list: string;
  /** The SQL that drops the database `name` if it exists. */
  drop(name: string): string;
}

/**
 * Drops the database `name` in the server `container` with the client of
 * `collector`. A shared server runs with AutoRemove, so a server that stopped
 * or is gone took its databases with it: that drop resolves.
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
    if (
      !(error instanceof ContainerNotFoundError) &&
      !(error instanceof ContainerNotRunningError)
    )
      throw error;
  }
}
