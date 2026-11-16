import { hash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What a claimed path holds on disk. A path with no file (deleted, or a new
 * doc not written yet) is its own state, never the hash of empty content.
 */
export type PathState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'file'; readonly sha256: string };

export async function readPathState(
  repoRoot: string,
  path: string,
): Promise<PathState> {
  try {
    const content = await readFile(join(repoRoot, path));
    return {
      kind: 'file',
      sha256: hash('sha256', content),
    };
  } catch (error) {
    if (Error.isError(error) && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'absent' };
    }
    throw error;
  }
}

export function formatPathState(state: PathState): string {
  return state.kind === 'absent' ? 'absent' : `sha256:${state.sha256}`;
}

/** The state a formatted text names, or 'invalid'. */
export function parsePathState(text: string): PathState | 'invalid' {
  if (text === 'absent') {
    return { kind: 'absent' };
  }
  const match = /^sha256:([\da-f]{64})$/.exec(text);
  return match?.[1] === undefined
    ? 'invalid'
    : { kind: 'file', sha256: match[1] };
}

export function samePathState(a: PathState, b: PathState): boolean {
  return formatPathState(a) === formatPathState(b);
}
