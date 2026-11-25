import { isRecord } from '../unknown-values.ts';

/** The file paths a manifest's `exports` maps to, in any of its forms. */
export function exportTargets(exports: unknown): string[] {
  if (typeof exports === 'string') return [exports];
  if (Array.isArray(exports)) return exports.flatMap(exportTargets);
  return isRecord(exports) ? Object.values(exports).flatMap(exportTargets) : [];
}

/**
 * The entry that the map `field` of `manifest` gives `subpath` (`.`, `./x` or
 * `#x`), as Node looks it up: the exact key, else the pattern with one `*`
 * whose prefix is the longest, with `*` in each target set to the text it
 * matched. Without a keyed `exports`, `.` is the whole `exports`, or `module`
 * and `main`.
 */
function subpathEntry(
  manifest: Record<string, unknown>,
  field: 'exports' | 'imports',
  subpath: string,
): unknown {
  const map = manifest[field];
  const keyed =
    isRecord(map) &&
    !Array.isArray(map) &&
    Object.keys(map).some((key) => key.startsWith('.') || key.startsWith('#'));
  if (!keyed) {
    if (field === 'imports' || subpath !== '.') return undefined;
    return map ?? [manifest['module'], manifest['main']];
  }
  if (Object.hasOwn(map, subpath)) return map[subpath];
  let best: { prefix: string; match: string; value: unknown } | undefined;
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf('*');
    if (star === -1 || key.includes('*', star + 1)) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.length >= key.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      prefix.length > (best?.prefix.length ?? -1)
    ) {
      const match = subpath.slice(
        prefix.length,
        subpath.length - suffix.length,
      );
      best = { prefix, match, value };
    }
  }
  if (!best) return undefined;
  const { match, value } = best;
  return exportTargets(value).map((target) => target.replaceAll('*', match));
}

/**
 * The paths, relative to the package root, that `subpath` of the package
 * reaches through `exports` or `imports`, under every condition: a bundler
 * picks one of them, and which one depends on its settings.
 */
export function subpathTargets(
  manifest: unknown,
  field: 'exports' | 'imports',
  subpath: string,
): string[] {
  return isRecord(manifest)
    ? exportTargets(subpathEntry(manifest, field, subpath))
    : [];
}
