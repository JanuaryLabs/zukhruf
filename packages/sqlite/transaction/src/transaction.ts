import type { DatabaseSync } from 'node:sqlite';

// When a transaction it owns starts, and so when it takes the write lock.
export type TransactionMode = 'deferred' | 'immediate' | 'exclusive';

// SQLite lets one name nest: ROLLBACK TO and RELEASE find the innermost.
const SAVEPOINT = 'zukhruf_transaction';

// Runs work in a transaction: commits when it returns, rolls back when it
// throws. Inside a transaction, work runs in a savepoint and the mode does not
// apply. The rollback runs only while SQLite still holds the transaction:
// after some errors SQLite ends the transaction itself, and a ROLLBACK then
// would replace the original error.
export function transaction<T>(
  database: Pick<DatabaseSync, 'exec' | 'isTransaction'>,
  work: () => T extends PromiseLike<unknown> ? never : T,
  options: { readonly mode: TransactionMode },
): T {
  const owns = !database.isTransaction;
  database.exec(
    owns ? `BEGIN ${options.mode.toUpperCase()}` : `SAVEPOINT ${SAVEPOINT}`,
  );
  try {
    const result = work();
    if (thenable(result))
      throw new TypeError('A transaction function cannot return a promise');
    database.exec(owns ? 'COMMIT' : `RELEASE ${SAVEPOINT}`);
    return result;
  } catch (error) {
    if (database.isTransaction)
      database.exec(
        owns ? 'ROLLBACK' : `ROLLBACK TO ${SAVEPOINT}; RELEASE ${SAVEPOINT}`,
      );
    throw error;
  }
}

function thenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}
