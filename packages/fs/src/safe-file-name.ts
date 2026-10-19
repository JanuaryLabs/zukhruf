import { createHash } from 'node:crypto';

/** The longest file name that ext4, APFS, NTFS and tmpfs accept. */
const longestFileName = 255;

/** Enough of a long key's start to recognize it in a directory listing. */
const visibleStart = 32;

/**
 * Maps any key to a single path segment that still fits a file name after the
 * caller adds up to `longestSuffix` characters. The name is the URI encoding of
 * the key, with each dot and each uppercase letter encoded too. A name thus has
 * no dot: a key can never be `.` or `..`, and a suffix such as `.lock` can never
 * make the name of another key. A name is ASCII, and it has no uppercase letter
 * outside an escape, whose hex digits are always uppercase. Thus two keys never
 * get names that are equal without case. APFS and NTFS compare file names
 * without case, and there too each key gets its own file, as on Linux.
 *
 * A key whose encoding does not fit, or that is not well-formed Unicode and so
 * has no encoding, gets the start of its encoding, `%%`, and the SHA-256 of its
 * UTF-16 code units. No encoding contains `%%`, so the two kinds of name never
 * meet; the digest is lowercase hex, so case cannot fold two digests into one
 * name; and the code units keep lone surrogates apart.
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
  return encodeURIComponent(key).replaceAll(/%[0-9A-F]{2}|[.A-Z]/g, (match) =>
    match.length === 1
      ? `%${match.charCodeAt(0).toString(16).toUpperCase()}`
      : match,
  );
}
