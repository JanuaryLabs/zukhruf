import { isRecord } from '../unknown-values.ts';

// The conditions Node itself sets for an ESM import, after the command's own.
const NODE_CONDITIONS = ['node', 'import', 'module-sync', 'default'];

function conditionalTarget(
  value: unknown,
  conditions: ReadonlySet<string>,
): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = conditionalTarget(item, conditions);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [condition, nested] of Object.entries(value)) {
    if (!conditions.has(condition)) continue;
    const target = conditionalTarget(nested, conditions);
    if (target !== undefined) return target;
  }
  return undefined;
}

function subpathTarget(
  exports: unknown,
  subpath: string,
  conditions: ReadonlySet<string>,
): string | undefined {
  const map =
    isRecord(exports) &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((key) => key.startsWith('.'))
      ? exports
      : { '.': exports };
  if (subpath in map) return conditionalTarget(map[subpath], conditions);
  // Node picks the pattern with the longest prefix before its `*`.
  const [pattern] = Object.keys(map)
    .filter((key) => {
      const [prefix, suffix, extra] = key.split('*');
      return (
        prefix !== undefined &&
        suffix !== undefined &&
        extra === undefined &&
        subpath.length >= prefix.length + suffix.length &&
        subpath.startsWith(prefix) &&
        subpath.endsWith(suffix)
      );
    })
    .toSorted((a, b) => b.indexOf('*') - a.indexOf('*'));
  if (pattern === undefined) return undefined;
  const [prefix = '', suffix = ''] = pattern.split('*');
  const match = subpath.slice(prefix.length, subpath.length - suffix.length);
  return conditionalTarget(map[pattern], conditions)?.replaceAll('*', match);
}

/**
 * The package-relative file that Node loads for `subpath` (`.` or `./x`) of a
 * package with `manifest`, under the command's `conditions` and Node's own.
 */
export function packageEntry(
  manifest: Record<string, unknown>,
  subpath: string,
  conditions: readonly string[],
): string | undefined {
  const exports = manifest['exports'];
  if (exports !== undefined) {
    return subpathTarget(
      exports,
      subpath,
      new Set([...conditions, ...NODE_CONDITIONS]),
    );
  }
  if (subpath !== '.') return subpath;
  const main = manifest['main'];
  return typeof main === 'string' ? main : 'index.js';
}

/** The package name and its subpath in a bare specifier: `@a/b/c` → `@a/b`, `./c`. */
export function splitSpecifier(specifier: string): {
  name: string;
  subpath: string;
} {
  const segments = specifier.split('/');
  const length = specifier.startsWith('@') ? 2 : 1;
  const name = segments.slice(0, length).join('/');
  const rest = segments.slice(length);
  return { name, subpath: rest.length === 0 ? '.' : `./${rest.join('/')}` };
}
