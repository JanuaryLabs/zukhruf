/** The key may have been granted to another holder while this lease was still in use. */
export class LockLostError extends Error {
	readonly key: string;

	constructor(key: string) {
		super(
			`Lost the lock on ${JSON.stringify(key)}: another holder may have been granted it.`,
		);
		this.name = 'LockLostError';
		this.key = key;
	}
}
