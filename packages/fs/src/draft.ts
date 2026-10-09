import { randomUUID } from 'node:crypto';

/**
 * A write fills a draft beside `path` and then puts it in place in one step,
 * so a reader sees the old content or the new content, never a part of it.
 * The random name keeps two writers of one path apart.
 */
export const draftOf = (path: string) => `${path}.${randomUUID()}.tmp`;

/**
 * The length of what a write adds to a path to name its draft. A caller that
 * makes long file names keeps this much room, or the draft's name is too long
 * for the file system.
 */
export const draftSuffixLength = draftOf('').length;
