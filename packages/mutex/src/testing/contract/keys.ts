import { randomUUID } from 'node:crypto';

/** Longer than any file name, so a lock store that names a file after the key cannot use the key as it is. */
export const longKey = 'k'.repeat(1000);

/** Names a key in a test title without printing all of a long key. */
export const label = (key: string) =>
  key.length > 32
    ? `${JSON.stringify(`…${key.slice(-4)}`)} of ${key.length} characters`
    : JSON.stringify(key);

/** Lock names of some servers belong to the whole server, and other tests share it. */
export const uniqueKey = () => `report:${randomUUID()}`;
