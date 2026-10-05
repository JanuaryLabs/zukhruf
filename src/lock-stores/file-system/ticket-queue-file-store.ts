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
	protected async lock(path: string): Promise<AsyncDisposable> {
		const me = Owner.current();
		await enqueue(path, me);

		return this.poll(async () => {
			const tickets = await readTickets(path);
			if (!tickets.some((ticket) => ticket.id === me.id)) {
				await enqueue(path, me);
				return undefined;
			}

			const [head] = tickets;
			if (head?.id === me.id) {
				return {
					[Symbol.asyncDispose]: async () => {
						const remaining = await readTickets(path);
						await replace(
							path,
							remaining.filter((ticket) => ticket.id !== me.id),
						);
					},
				};
			}

			if (head && !head.isAlive()) {
				await this.withReclaimLock(path, () => evictDeadHead(path));
			}
			return undefined;
		});
	}
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
