import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';

const execFileAsync = promisify(execFile);

// A package that `npm pack` makes offline from its source, a temp folder in
// `top`, into `top/tarballs`, so that an install of it reaches no registry.
// Its main file index.js holds `code`, by default an export of its version.
// Returns the `file:` URL of the tarball, for a dependency in package.json.
export async function probeTarball(
  top: string,
  environment: Readonly<Record<string, string>>,
  manifest: Readonly<{
    name: string;
    version: string;
    scripts?: Readonly<Record<string, string>>;
    dependencies?: Readonly<Record<string, string>>;
  }>,
  code = `exports.version = '${manifest.version}';\n`,
) {
  const { name, version } = manifest;
  const tarballs = join(top, 'tarballs');
  await mkdir(tarballs, { recursive: true });
  await using source = await new TemporaryFiles().directory(
    `${name}-${version}-`,
    {
      parent: top,
      files: {
        'package.json': JSON.stringify({ ...manifest, main: 'index.js' }),
        'index.js': code,
      },
    },
  );
  await execFileAsync(
    'npm',
    [
      'pack',
      '--pack-destination',
      tarballs,
      '--offline',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: source.path, env: environment },
  );
  return `file:${join(tarballs, `${name}-${version}.tgz`)}`;
}
