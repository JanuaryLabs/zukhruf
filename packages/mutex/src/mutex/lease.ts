import type { FencingToken } from '../fencing/fencing-token.ts';
import type { TokenSource } from '../fencing/token-source.ts';

/** Proof of holding a key: pass `token` to fenced resources; dispose to release. */
export interface Lease extends AsyncDisposable {
	readonly token: FencingToken;
}

/** Mints the token for a lock that is already held, releasing the lock if minting fails. */
export async function leaseFor(
	key: string,
	held: AsyncDisposable,
	tokens: TokenSource,
): Promise<Lease> {
	try {
		const token = await tokens.next(key);
		return { token, [Symbol.asyncDispose]: () => held[Symbol.asyncDispose]() };
	} catch (error) {
		await held[Symbol.asyncDispose]();
		throw error;
	}
}
