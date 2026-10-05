import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isErrno } from './errno.ts';

/** How long to retry a rename that Windows refuses while another handle has the target open. */
const WINDOWS_RENAME_PATIENCE = 1000;

/** Replaces `path` in one step, so readers see the old or the new content, never a partial write. */
export async function atomicWrite(path: string, content: string) {
	const draft = `${path}.${randomUUID()}.tmp`;
	await writeFile(draft, content);
	await replaceWith(draft, path);
}

/**
 * On Windows, a rename over a file fails while another process has that file
 * open, for example a waiter that reads it at that moment. The refusal is
 * brief, so the rename is tried again; it stays the single commit point.
 */
async function replaceWith(draft: string, path: string) {
	const started = performance.now();
	for (let attempt = 0; ; attempt++) {
		try {
			return await rename(draft, path);
		} catch (error) {
			const refusedForNow =
				process.platform === 'win32' &&
				['EPERM', 'EACCES', 'EBUSY'].some((code) => isErrno(error, code));
			if (!refusedForNow || performance.now() - started > WINDOWS_RENAME_PATIENCE) throw error;
			await delay(Math.min(5 * 2 ** attempt, 100));
		}
	}
}
