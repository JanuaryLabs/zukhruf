import { DatabaseSync } from 'node:sqlite';
import { isBusy } from '../../shared/sqlite/is-busy.ts';
import { FileLockStore } from '../file-system/file-lock-store.ts';

/**
 * Holds an exclusive SQLite transaction on the key's database file. SQLite
 * locks through the kernel, which releases them when the holder dies, so a
 * crash never leaves a key locked. Keep the default rollback journal: in WAL
 * mode an exclusive transaction no longer blocks readers.
 */
export class SqliteStore extends FileLockStore {
	protected async lock(path: string): Promise<AsyncDisposable> {
		const database = new DatabaseSync(path, { timeout: 0 });
		try {
			await this.poll(async () => {
				try {
					database.exec('BEGIN EXCLUSIVE');
					return true;
				} catch (error) {
					if (isBusy(error)) return undefined;
					throw error;
				}
			});
		} catch (error) {
			database.close();
			throw error;
		}

		return {
			[Symbol.asyncDispose]: async () => {
				database.exec('ROLLBACK');
				database.close();
			},
		};
	}
}
