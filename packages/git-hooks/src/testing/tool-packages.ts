import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const zukhrufModules = new URL('../../../../node_modules', import.meta.url)
  .pathname;

// The bin that each tool that a step runs puts in node_modules/.bin.
const bins: Readonly<Record<string, string>> = {
  nx: '../nx/dist/bin/nx.js',
  prettier: '../prettier/bin/prettier.cjs',
  eslint: '../eslint/bin/eslint.js',
};

// Gives a test repo at `root` the packages that a snapshot of its commit
// links: a node_modules with zukhruf's install of each of `tools` (a package
// or a scope such as @nx) and its bin, a link to each workspace package, and
// the hidden lockfile of that install, with each tool package at the version
// that zukhruf installed. It writes the package-lock.json that the commit
// stages: the root, the tool packages, each workspace package and its link.
// The hidden lockfile then matches it, so the snapshot uses this node_modules
// and installs nothing.
export async function toolPackages(
  root: string,
  tools: readonly string[],
  workspaces: readonly {
    readonly folder: string;
    readonly name: string;
  }[] = [],
): Promise<void> {
  const modules = join(root, 'node_modules');
  await mkdir(join(modules, '.bin'), { recursive: true });
  for (const name of tools)
    await symlink(join(zukhrufModules, name), join(modules, name));
  const packages: Record<string, object> = {};
  for (const name of tools.filter((tool) => !tool.startsWith('@'))) {
    const bin = bins[name];
    if (bin !== undefined) await symlink(bin, join(modules, '.bin', name));
    const manifest: unknown = JSON.parse(
      await readFile(join(zukhrufModules, name, 'package.json'), 'utf8'),
    );
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      !('version' in manifest) ||
      typeof manifest.version !== 'string'
    )
      throw new TypeError(`zukhruf's ${name} has no version`);
    const { version } = manifest;
    packages[`node_modules/${name}`] = { version, license: 'MIT' };
  }
  for (const { folder, name } of workspaces) {
    packages[`node_modules/${name}`] = { resolved: folder, link: true };
    packages[folder] = { name, version: '0.0.0' };
    const scope = name.slice(0, name.indexOf('/'));
    await mkdir(join(modules, scope), { recursive: true });
    await symlink(join('../..', folder), join(modules, name));
  }
  const lockfile = (all: Record<string, object>) =>
    `${JSON.stringify({ name: 'probe', lockfileVersion: 3, requires: true, packages: all }, null, 2)}\n`;
  await writeFile(join(modules, '.package-lock.json'), lockfile(packages));
  await writeFile(
    join(root, 'package-lock.json'),
    lockfile({
      '': { name: 'probe', workspaces: ['packages/*'] },
      ...packages,
    }),
  );
}
