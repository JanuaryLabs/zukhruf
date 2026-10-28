import { randomBytes, randomUUID } from 'node:crypto';

import type { CancelOptions, Container } from '@zukhruf/docker';

import type { DockerHost } from '../docker/host.ts';

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
    ? `test_${hex(id)}_${randomBytes(8).toString('hex')}`
    : `test_${hex(randomUUID())}`;

/**
 * The databases of one server kind: `list` gives the names of the server's
 * test databases, and `drop` drops one. Disposal and the run's cleanup both
 * drop with `drop`.
 */
export interface Collector<Server> {
  readonly kind: Kind;
  /**
   * The running shared server `container`, with the credentials of
   * `environment`, its `Config.Env`. Disposal closes what it opened.
   */
  open(
    container: Container,
    environment: Record<string, string>,
    host: DockerHost,
  ): Promise<Server & AsyncDisposable>;
  /** Each database whose name starts with `test`, a superset of a run's. */
  list(server: Server, cancel: CancelOptions): Promise<string[]>;
  /** Drops the database `name` if it exists. */
  drop(server: Server, name: string, cancel: CancelOptions): Promise<void>;
}

/**
 * Whether `name` is a database of the run `runId`. `_` is a wildcard of
 * SQL's LIKE, so only the exact name pattern proves a run's database.
 */
export const ownedBy =
  (runId: string) =>
  (name: string): boolean => {
    const prefix = `test_${hex(runId)}_`;
    return (
      name.startsWith(prefix) && /^[\da-f]{16}$/.test(name.slice(prefix.length))
    );
  };
