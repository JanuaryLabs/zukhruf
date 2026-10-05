import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';

/** Replaces `path` in one step, so readers see the old or the new content, never a partial write. */
export async function atomicWrite(path: string, content: string) {
	const draft = `${path}.${randomUUID()}.tmp`;
	await writeFile(draft, content);
	await rename(draft, path);
}
