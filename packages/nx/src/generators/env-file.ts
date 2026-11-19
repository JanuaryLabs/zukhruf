import type { Tree } from '@nx/devkit';

/**
 * Adds `KEY=value` to an env file that has no line for the key. A line that is
 * there keeps its value. A missing file gets the one line. The prisma and auth
 * generators and the migrations use it (ADR 0014 decision 12, ADR 0017).
 */
export function addEnvEntry(
  tree: Tree,
  path: string,
  key: string,
  value: string,
): void {
  const content = tree.read(path, 'utf-8') ?? '';
  if (new RegExp(`^${key}=`, 'm').test(content)) return;
  const separator = content === '' || content.endsWith('\n') ? '' : '\n';
  tree.write(path, `${content}${separator}${key}=${value}\n`);
}
