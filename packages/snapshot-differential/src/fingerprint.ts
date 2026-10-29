import { createHash } from 'node:crypto';

import { base64url } from './bytes.ts';

// A record's SHA-256 over its canonical form, so equal records hash equally.
export function fingerprintOf(
  name: string,
  record: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(canonical(name, record))
    .digest('base64url');
}

// JSON with object keys sorted at every depth. Bytes are # and their
// base64url: a JSON text has no # outside a string, so no JSON value has the
// form of bytes. A value that JSON cannot hold with no change fails.
function canonical(name: string, value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      !Object.is(value, -0))
  )
    return JSON.stringify(value);
  if (value instanceof Uint8Array) return `#${base64url(value)}`;
  if (Array.isArray(value) && Object.keys(value).length === value.length)
    return `[${value.map((item) => canonical(name, item)).join(',')}]`;
  if (isPlainObject(value) && Object.getOwnPropertySymbols(value).length === 0)
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(name, value[key])}`)
      .join(',')}}`;
  throw new TypeError(
    `Snapshot ${name} records must be losslessly JSON serializable, or bytes, to diff snapshots`,
  );
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
