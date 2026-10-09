import { createHash } from 'node:crypto';

/** The longest file name that ext4, APFS, NTFS and tmpfs accept. */
const longestFileName = 255;

/** Enough of a long key's start to recognize it in a directory listing. */
const visibleStart = 32;

/**
 * Maps any key to a single path segment that still fits a file name after the
 * caller adds up to `longestSuffix` characters. Encoding every dot means a key
 * can never be `.` or `..`, and suffixes such as `.lock` can never collide with
 * a key. On a case-insensitive file system, keys that differ only by case share
 * a name, which over-locks but never under-locks.
 *
 * A key whose encoding does not fit, or that is not well-formed Unicode and so
 * has no encoding, gets the start of its encoding, `%%`, and the SHA-256 of its
 * UTF-16 code units. A key that fits keeps the name earlier versions gave it, so
 * processes of two versions share its lock. No encoding contains `%%`, so the
 * two kinds of name never meet; the digest is hex, whose one case cannot fold
 * two digests into one name; and the code units keep lone surrogates apart.
 */
export function safeFileName(key: string, longestSuffix: number): string {
  if (key.isWellFormed()) {
    const encoded = encode(key);
    if (encoded.length + longestSuffix <= longestFileName) return encoded;
  }
  const start = encode(key.toWellFormed())
    .slice(0, visibleStart)
    .replace(/%[0-9A-F]?$/, '');
  const digest = createHash('sha256')
    .update(Buffer.from(key, 'utf16le'))
    .digest('hex');
  return `${start}%%${digest}`;
}

function encode(key: string): string {
  return encodeURIComponent(key).replaceAll('.', '%2E');
}
