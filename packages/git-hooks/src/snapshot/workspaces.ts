import { glob, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// The folders of the workspace packages that the `workspaces` field of the
// root package.json in `folder` names, relative to `folder`.
export async function workspaceFolders(folder: string): Promise<string[]> {
  const manifest: unknown = JSON.parse(
    await readFile(join(folder, 'package.json'), 'utf8'),
  );
  const field =
    typeof manifest === 'object' &&
    manifest !== null &&
    'workspaces' in manifest
      ? manifest.workspaces
      : [];
  const patterns =
    typeof field === 'object' && field !== null && 'packages' in field
      ? field.packages
      : field;
  if (
    !Array.isArray(patterns) ||
    !patterns.every((pattern) => typeof pattern === 'string')
  )
    return [];
  const folders = new Set<string>();
  for await (const path of glob(
    patterns.map((pattern) => `${pattern}/package.json`),
    {
      cwd: folder,
      exclude: (path) => path.split(/[\\/]/).includes('node_modules'),
    },
  ))
    folders.add(dirname(path));
  return [...folders];
}
