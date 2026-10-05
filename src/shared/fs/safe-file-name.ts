/**
 * Maps any key to a single path segment. Encoding every dot means a key can
 * never be `.` or `..`, and suffixes such as `.lock` can never collide with a key.
 * On a case-insensitive file system, keys that differ only by case share a
 * name, which over-locks but never under-locks.
 */
export function safeFileName(key: string): string {
	return encodeURIComponent(key).replaceAll('.', '%2E');
}
