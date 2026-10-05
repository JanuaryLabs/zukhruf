import { randomUUID } from 'node:crypto';
import { link, unlink, writeFile } from 'node:fs/promises';
import { isErrno } from './errno.ts';

/**
 * Creates `path` holding `content` unless it already exists. Linking a fully
 * written file makes creation atomic, so the file is never seen empty.
 */
export async function createExclusive(path: string, content: string) {
	const draft = `${path}.${randomUUID()}.tmp`;
	await writeFile(draft, content);
	try {
		await link(draft, path);
		return true;
	} catch (error) {
		if (isErrno(error, 'EEXIST')) return false;
		throw error;
	} finally {
		await unlink(draft);
	}
}
