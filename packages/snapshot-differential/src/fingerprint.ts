import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// A record's SHA-256 over its canonical JSON, so equal records hash equally.
export function fingerprintOf(
  name: string,
  record: Record<string, unknown>,
): string {
  const serialized: unknown = JSON.parse(JSON.stringify(record));
  if (!isDeepStrictEqual(serialized, record))
    throw new TypeError(
      `Snapshot ${name} records must be losslessly JSON serializable to diff snapshots`,
    );
  return createHash('sha256').update(canonical(serialized)).digest('base64url');
}

// JSON with object keys sorted at every depth.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
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
