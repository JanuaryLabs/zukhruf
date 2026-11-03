import type { Database } from '@zukhruf/testing/sqlserver';

import type { Fixture } from '../contract/subject.ts';

/** How a store of a server case reaches its database. The location of the fixture is this object as JSON. */
export interface Server {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export const serverOf = ({
  host,
  port,
  user,
  password,
  database,
}: Database): Server => ({
  host,
  port,
  user,
  password,
  database,
});

export const serverAt = (location: string): Server => JSON.parse(location);

/**
 * Makes a new database with `prepare`, which creates what the app creates
 * before it starts. The fixture drops the database.
 */
export async function serverFixture(
  database: Database,
  prepare: () => Promise<void>,
): Promise<Fixture> {
  try {
    await prepare();
  } catch (error) {
    await database.cleanup();
    throw error;
  }
  return {
    location: JSON.stringify(serverOf(database)),
    [Symbol.asyncDispose]: () => database.cleanup(),
  };
}
