import { DatabaseSync } from 'node:sqlite';
import type { FencingToken } from '../fencing/fencing-token.ts';

/**
 * A durable counter that honours fencing tokens: a write that carries a token
 * older than the newest one it has seen is refused, so tests can observe a
 * stale holder being fenced off.
 */
export class FencedRegister {
	readonly #database: DatabaseSync;

	constructor(path: string) {
		this.#database = new DatabaseSync(path, { readBigInts: true, timeout: 1000 });
		this.#database.exec(`
			CREATE TABLE IF NOT EXISTS register (
				id     INTEGER PRIMARY KEY CHECK (id = 1),
				writes INTEGER NOT NULL,
				fence  INTEGER NOT NULL
			);
			INSERT INTO register VALUES (1, 0, 0) ON CONFLICT DO NOTHING;
		`);
	}

	write(token: FencingToken): 'written' | 'stale' {
		const { changes } = this.#database
			.prepare(
				'UPDATE register SET writes = writes + 1, fence = ? WHERE id = 1 AND fence <= ?',
			)
			.run(token.value, token.value);
		return Number(changes) > 0 ? 'written' : 'stale';
	}

	writes(): number {
		const row = this.#database.prepare('SELECT writes FROM register').get() as {
			writes: bigint;
		};
		return Number(row.writes);
	}
}
