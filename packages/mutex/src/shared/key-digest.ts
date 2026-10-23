import { createHash } from 'node:crypto';

/**
 * The SHA-256 digest of the UTF-16 code units of `key`. The code units, not
 * UTF-8, so that keys that differ only in a lone surrogate get different
 * digests. Each lock store encodes the digest in the form that its server
 * takes.
 */
export function keyDigest(key: string): Buffer {
  return createHash('sha256').update(Buffer.from(key, 'utf16le')).digest();
}
