import { appendFile, readFile } from 'node:fs/promises';
import { atomicWrite } from '../../shared/fs/atomic-write.ts';
import { isErrno } from '../../shared/fs/errno.ts';
import { FileLockStore } from './file-lock-store.ts';
import { Owner } from './owner.ts';

/**
 * FIFO queue in one file: each waiter appends its ticket line and holds the
 * lock once its ticket is first.
 *
 * Appends are atomic (O_APPEND), and the file is only ever replaced by the
 * live head releasing or by the reclaim-lock holder evicting a dead head, so
 * two rewrites never race. A rewrite racing an append can drop that ticket;
 * its waiter notices and appends it again.
 */
export class TicketQueueFileStore extends FileLockStore {
	protected async lock(
		path: string,
		signal: AbortSignal | undefined,
	): Promise<AsyncDisposable> {
		const me = Owner.current();
		await enqueue(path, me);
		try {
			return await this.poll(() => this.#attempt(path, me), { signal });
		} catch (error) {
			this.#leaveWhenFirst(path, me);
			throw error;
		}
	}

	protected async tryLock(path: string): Promise<AsyncDisposable | undefined> {
		const [head] = await readTickets(path);
		await this.#evictIfDead(path, head);
		if ((await readTickets(path)).length > 0) return undefined;

		const me = Owner.current();
		await enqueue(path, me);
		const [first] = await readTickets(path);
		if (first?.id === me.id) return holding(path, me);
		// Another waiter appended at the same moment and is first.
		this.#leaveWhenFirst(path, me);
		return undefined;
	}

	async #evictIfDead(path: string, head: Owner | undefined) {
		if (head && !head.isAlive()) {
			await this.withReclaimLock(path, () => evictDeadHead(path));
		}
	}

	async #attempt(path: string, me: Owner): Promise<AsyncDisposable | undefined> {
		const tickets = await readTickets(path);
		if (!tickets.some((ticket) => ticket.id === me.id)) {
			await enqueue(path, me);
			return undefined;
		}

		const [head] = tickets;
		if (head?.id === me.id) return holding(path, me);

		await this.#evictIfDead(path, head);
		return undefined;
	}

	/**
	 * A waiter that gives up cannot remove its ticket: only the head may
	 * rewrite the queue. So its ticket stays in line, and this removes it when
	 * it reaches the head. The wait does not keep the process alive; if the
	 * process stops first, waiters evict the ticket as a dead head.
	 */
	#leaveWhenFirst(path: string, me: Owner) {
		this.poll(
			async () => {
				const tickets = await readTickets(path);
				if (!tickets.some((ticket) => ticket.id === me.id)) return true;
				const [head] = tickets;
				if (head?.id === me.id) {
					await removeTicket(path, me);
					return true;
				}
				await this.#evictIfDead(path, head);
				return undefined;
			},
			{ keepAlive: false },
		).catch(() => {
			// The directory is gone, so the ticket is gone too.
		});
	}
}

function holding(path: string, me: Owner): AsyncDisposable {
	return { [Symbol.asyncDispose]: () => removeTicket(path, me) };
}

async function removeTicket(path: string, me: Owner) {
	const remaining = await readTickets(path);
	await replace(
		path,
		remaining.filter((ticket) => ticket.id !== me.id),
	);
}

async function evictDeadHead(path: string) {
	const [head, ...rest] = await readTickets(path);
	if (head && !head.isAlive()) await replace(path, rest);
}

async function enqueue(path: string, owner: Owner) {
	await appendFile(path, `${owner.serialize()}\n`);
}

async function readTickets(path: string): Promise<Owner[]> {
	try {
		const content = await readFile(path, 'utf8');
		// The last segment is empty or a ticket still being appended.
		return content.split('\n').slice(0, -1).map(Owner.parse);
	} catch (error) {
		if (isErrno(error, 'ENOENT')) return [];
		throw error;
	}
}

async function replace(path: string, tickets: Owner[]) {
	await atomicWrite(
		path,
		tickets.map((ticket) => `${ticket.serialize()}\n`).join(''),
	);
}
