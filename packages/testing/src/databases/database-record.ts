import type { Container } from '@zukhruf/docker';

import type { DockerTestbed } from '../docker/testbed.ts';
import {
  type Collector,
  KIND_LABEL,
  databaseName,
  dropDatabase,
} from './collector.ts';

/** The label of a database record: the name of its database (ADR 0032). */
export const DATABASE_LABEL = 'dev.zukhruf.testing.database';

/** The label of a database record: the id of the server that holds its database. */
export const DATABASE_SERVER_LABEL = 'dev.zukhruf.testing.database.server';

/** A database that `database()` created in a shared server. */
export interface SharedDatabase {
  readonly name: string;
  /**
   * Drops the database, then removes its record. A drop that fails rejects
   * and keeps the record, so the reaper of the run drops the database.
   */
  drop(): Promise<void>;
}

/**
 * Creates a database with `create` in the shared server `server`, after its
 * record: in a run, a volume with the run's labels, the database's name, the
 * server's id and its kind, which the reaper of the run reads to drop the
 * database when this process dies first (ADR 0032). Kubernetes writes the
 * owner of an object on the object when it creates it, by the owner's uid
 * (ownerReferences), so no object exists that no owner names. The record holds
 * the server's id, not its fingerprint: a server that a later process starts
 * with the same fingerprint does not hold this database.
 */
export async function createSharedDatabase(
  testbed: DockerTestbed,
  runId: string | undefined,
  collector: Collector,
  server: Container,
  credential: string,
  create: (name: string) => Promise<unknown>,
): Promise<SharedDatabase> {
  const name = databaseName(runId);
  const record =
    runId === undefined
      ? undefined
      : await writeRecord(testbed, collector, server, name);
  await create(name);
  return {
    name,
    async drop() {
      await dropDatabase(collector, server, credential, name);
      await record?.remove();
    },
  };
}

/** Writes the record of the database `name` after this process holds the reaper of its run. */
async function writeRecord(
  testbed: DockerTestbed,
  collector: Collector,
  server: Container,
  name: string,
) {
  const { Labels } = await testbed.defaults();
  const client = await testbed.client();
  return client.volumes.create({
    Name: `zukhruf-testing-database-${name}`,
    Labels: {
      ...Labels,
      [DATABASE_LABEL]: name,
      [DATABASE_SERVER_LABEL]: server.id,
      [KIND_LABEL]: collector.kind,
    },
  });
}
