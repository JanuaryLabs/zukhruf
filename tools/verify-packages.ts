/**
 * Installs every public package from the tarball `npm pack` makes, the way a
 * consumer gets it, and imports each export. Node.js refuses to strip types
 * inside node_modules, so a package only works for consumers when its exports
 * point at the build output and the tarball carries it. Run it after a build.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  globSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// npm is npm.cmd on Windows, and Node.js runs .cmd files only through a shell.
const npm = (args: string[], cwd: string): string =>
  execFileSync('npm', args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

const leaves = (target: unknown): string[] => {
  if (typeof target === 'string') {
    return [target];
  }
  if (typeof target === 'object' && target !== null) {
    return Object.values(target).flatMap(leaves);
  }
  return [];
};

const workspace = resolve(import.meta.dirname, '..');
const consumer = mkdtempSync(join(tmpdir(), 'zukhruf-consumer-'));

try {
  const packages = globSync('packages/*/package.json', { cwd: workspace })
    .map((file) => ({
      directory: join(workspace, dirname(file)),
      manifest: JSON.parse(readFileSync(join(workspace, file), 'utf8')),
    }))
    .filter(({ manifest }) => !manifest.private);

  const tarballs = packages.map(({ directory, manifest }) => {
    const [packed] = JSON.parse(
      npm(
        ['pack', '--json', '--ignore-scripts', '--pack-destination', consumer],
        directory,
      ),
    );
    const files = new Set<string>(
      packed.files.map(({ path }: { path: string }) => path),
    );
    for (const target of leaves(manifest.exports)) {
      assert.ok(
        files.has(target.replace(/^\.\//, '')),
        `${manifest.name}: export target ${target} is not in the tarball`,
      );
    }
    for (const file of files) {
      assert.doesNotMatch(
        file,
        /^dist\/(spec|testing)\//,
        `${manifest.name}: test support ${file} is in the tarball`,
      );
    }
    return join(consumer, packed.filename);
  });

  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
  );
  npm(
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...tarballs],
    consumer,
  );

  for (const { manifest } of packages) {
    for (const subpath of Object.keys(manifest.exports)) {
      if (subpath === './package.json') continue;
      const specifier = manifest.name + subpath.slice(1);
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `await import(${JSON.stringify(specifier)});`,
        ],
        { cwd: consumer },
      );
      console.log(`${specifier} imports from node_modules`);
    }
  }
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
