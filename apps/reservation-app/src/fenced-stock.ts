import { DatabaseSync } from 'node:sqlite';
import type { FencingToken } from '@zukhruf/mutex';

export type Reservation = 'reserved' | 'sold-out' | 'stale';

/**
 * Stock that honours fencing tokens. Each product remembers the newest token
 * that reserved it and refuses an older one, so a holder that lost its lock
 * without knowing cannot act after a newer holder. Each reservation is one
 * conditional UPDATE, so checking and decrementing cannot interleave.
 */
export class FencedStock implements Disposable {
	readonly #database: DatabaseSync;

	constructor(path: string) {
		this.#database = new DatabaseSync(path, {
			readBigInts: true,
			timeout: 1000,
		});
		this.#database.exec(`
			CREATE TABLE IF NOT EXISTS stock (
				product  TEXT PRIMARY KEY,
				quantity INTEGER NOT NULL,
				fence    INTEGER NOT NULL DEFAULT 0
			)
		`);
	}

	/** Sets the starting quantity of a product this stock has never seen. */
	seed(product: string, quantity: number) {
		this.#database
			.prepare(
				'INSERT INTO stock (product, quantity) VALUES (?, ?) ON CONFLICT (product) DO NOTHING',
			)
			.run(product, quantity);
	}

	restock(product: string, quantity: number) {
		this.#database
			.prepare(
				`INSERT INTO stock (product, quantity) VALUES (?, ?)
				 ON CONFLICT (product) DO UPDATE SET quantity = quantity + excluded.quantity`,
			)
			.run(product, quantity);
	}

	quantity(product: string): number {
		const row = this.#database
			.prepare('SELECT quantity FROM stock WHERE product = ?')
			.get(product) as { quantity: bigint } | undefined;
		return Number(row?.quantity ?? 0n);
	}

	reserve(product: string, token: FencingToken): Reservation {
		const { changes } = this.#database
			.prepare(
				`UPDATE stock SET quantity = quantity - 1, fence = ?
				 WHERE product = ? AND fence <= ? AND quantity > 0`,
			)
			.run(token.value, product, token.value);
		if (Number(changes) > 0) return 'reserved';

		const row = this.#database
			.prepare('SELECT fence FROM stock WHERE product = ?')
			.get(product) as { fence: bigint } | undefined;
		return row && row.fence > token.value ? 'stale' : 'sold-out';
	}

	close() {
		this.#database.close();
	}

	[Symbol.dispose]() {
		this.close();
	}
}
