import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const zukhrufModules = fileURLToPath(
  new URL('../../../../node_modules', import.meta.url),
);
const nxBin = join(zukhrufModules, 'nx/dist/bin/nx.js');

interface Manifest {
  name: string;
  version: string;
  license: string;
  bin?: string | Record<string, string>;
}

/**
 * An npm workspace in a temp folder with `packages/*` as its workspace globs
 * and `plugins` in `nx.json`. Each package of `links` is linked from zukhruf
 * with its bins and its lockfile entry, as npm installs it; `packages` adds
 * more lockfile entries. Nx sees none of the user's config and no
 * environment of the Nx task that runs the test.
 */
export async function workspace<Target>({
  root,
  files,
  plugins,
  links,
  packages,
}: {
  root: string;
  files: Record<string, string>;
  plugins: (string | object)[];
  links: string[];
  packages: Record<string, object>;
}) {
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write(
    'package.json',
    '{ "name": "probe", "private": true, "workspaces": ["packages/*"] }\n',
  );
  await write(
    'nx.json',
    `${JSON.stringify({ useDaemonProcess: false, plugins })}\n`,
  );
  for (const [path, content] of Object.entries(files)) {
    await write(path, content);
  }
  await mkdir(join(root, 'home'));
  await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
  const linked: Record<string, object> = {};
  for (const name of links) {
    const target = join(root, 'node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(join(zukhrufModules, name), target);
    const manifest: Manifest = JSON.parse(
      await readFile(join(zukhrufModules, name, 'package.json'), 'utf8'),
    );
    const bins =
      typeof manifest.bin === 'string'
        ? { [basename(manifest.name)]: manifest.bin }
        : (manifest.bin ?? {});
    for (const [bin, file] of Object.entries(bins)) {
      await symlink(
        join('..', name, file),
        join(root, 'node_modules/.bin', bin),
      );
    }
    linked[`node_modules/${name}`] = {
      version: manifest.version,
      license: manifest.license,
    };
  }
  const lockfile = (lockfilePackages: Record<string, object>) =>
    write(
      'package-lock.json',
      `${JSON.stringify(
        {
          name: 'probe',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'probe', workspaces: ['packages/*'] },
            ...linked,
            ...lockfilePackages,
          },
        },
        null,
        2,
      )}\n`,
    );
  await lockfile(packages);
  const environment = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: join(root, 'home'),
    NX_DAEMON: 'false',
    NX_NO_CLOUD: 'true',
  };
  const nx = async (...args: string[]) => {
    const child = spawn(process.execPath, [nxBin, ...args], {
      cwd: root,
      env: environment,
      timeout: 60_000,
    });
    const stdoutChunks = child.stdout.toArray();
    const stderrChunks = child.stderr.toArray();
    const [code] = await once(child, 'close');
    const stdout = Buffer.concat(await stdoutChunks).toString();
    const stderr = Buffer.concat(await stderrChunks).toString();
    return { code, stdout, output: stdout + stderr };
  };
  const targets = async (project: string) => {
    const shown = await nx('show', 'project', project, '--json');
    assert.equal(shown.code, 0, shown.output);
    const configuration: { targets: Record<string, Target> } = JSON.parse(
      shown.stdout,
    );
    return configuration.targets;
  };
  return {
    nx,
    targets,
    write,
    lockfile,
    read: (path: string) => readFile(join(root, path), 'utf8'),
  };
}
