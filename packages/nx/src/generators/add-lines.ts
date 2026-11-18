import type { Tree } from '@nx/devkit';

/**
 * Adds each line of `content` that the file does not have, and never removes
 * or reorders a line. Comments and empty lines are not added. A missing file
 * gets `content` as it is.
 */
export function addLines(tree: Tree, path: string, content: string): void {
  const existing = tree.read(path, 'utf-8');
  if (existing === null) {
    tree.write(path, content);
    return;
  }
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = content
    .split('\n')
    .filter(
      (line) => line !== '' && !line.startsWith('#') && !present.has(line),
    );
  if (missing.length === 0) return;
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  tree.write(path, `${existing}${separator}${missing.join('\n')}\n`);
}
