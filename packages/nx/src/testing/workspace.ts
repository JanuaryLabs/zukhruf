import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TemporaryFiles } from '@zukhruf/fs';
import { Command, ExitError } from '@zukhruf/process';

export const zukhrufModules = fileURLToPath(
  new URL('../../../../node_modules', import.meta.url),
);
const nxBin = join(zukhrufModules, 'nx/dist/bin/nx.js');

/**
 * The folders of the POSIX tools that the fixtures' scripts and the targets
 * call, where this machine keeps them: /usr/bin and /bin on macOS and Ubuntu,
 * /run/current-system/sw/bin on NixOS, whose /usr/bin and /bin hold only env
 * and sh (#6131).
 */
const toolFolders = [
  ...new Set(
    await Promise.all(
      ['basename', 'mkdir', 'rm'].map(async (tool) => {
        const found = await new Command('sh', ['-c', `command -v ${tool}`], {
          env: process.env,
          clock: globalThis,
        }).run();
        if (found.exitCode !== 0) {
          throw new ExitError(`command -v ${tool}`, found);
        }
        return dirname(found.stdout.trim());
      }),
    ),
  ),
];

interface Manifest {
  name: string;
  version: string;
  license: string;
  bin?: string | Record<string, string>;
}

/**
 * An npm workspace in a temp folder that the returned workspace owns: hold it
 * with `await using`. It has `packages/*` as its workspace globs, `plugins` in
 * `nx.json`, and `files` written over those. Each package of `links` is
 * linked from zukhruf with its bins and its lockfile entry, as npm installs
 * it; `packages` adds more lockfile entries. Nx sees none of the user's
 * config and no environment of the Nx task that runs the test. An abort of
 * `signal`, the test's `t.signal`, stops the running nx process.
 */
export async function workspace<Target>({
  files,
  plugins,
  links,
  packages,
  signal,
}: {
  files: Record<string, string>;
  plugins: (string | object)[];
  links: string[];
  packages: Record<string, object>;
  signal: AbortSignal;
}) {
  const manifests = new Map<string, Manifest>();
  for (const name of links) {
    manifests.set(
      name,
      JSON.parse(
        await readFile(join(zukhrufModules, name, 'package.json'), 'utf8'),
      ),
    );
  }
  const linked = Object.fromEntries(
    [...manifests].map(([name, manifest]) => [
      `node_modules/${name}`,
      { version: manifest.version, license: manifest.license },
    ]),
  );
  const lockfile = (lockfilePackages: Record<string, object>) =>
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
    )}\n`;
  await using resources = new AsyncDisposableStack();
  const { path: root } = resources.use(
    await new TemporaryFiles().directory('zukhruf-nx-', {
      files: {
        'package.json':
          '{ "name": "probe", "private": true, "workspaces": ["packages/*"] }\n',
        'nx.json': `${JSON.stringify({ useDaemonProcess: false, plugins })}\n`,
        ...files,
        'package-lock.json': lockfile(packages),
      },
    }),
  );
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await mkdir(join(root, 'home'));
  await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
  for (const [name, manifest] of manifests) {
    const target = join(root, 'node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(join(zukhrufModules, name), target);
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
  }
  const environment = {
    PATH: [
      ...new Set([
        dirname(process.execPath),
        ...toolFolders,
        '/usr/bin',
        '/bin',
      ]),
    ].join(':'),
    HOME: join(root, 'home'),
    NX_DAEMON: 'false',
    NX_NO_CLOUD: 'true',
    // Each plugin loads in the nx process instead of a worker process of its
    // own: the graphs that the tests check are the same, and a run of the
    // slowest generator test takes 4.1 s instead of 6.5 s and 42% less CPU
    // (2026-11-27, #6126). Ezz chose it for every test.
    NX_ISOLATE_PLUGINS: 'false',
  };
  // One nx process at a time in the workspace: without a daemon, nx 24.0.6
  // lets the second of two processes wait on the graph lock and then only read
  // the cached graph, so a first process that wrote no graph fails it with
  // "No cached ProjectGraph is available" (#6138).
  let previous: Promise<unknown> = Promise.resolve();
  const nx = (...args: string[]) => {
    const run = previous.then(() => runNx(args));
    previous = run.catch(() => undefined);
    return run;
  };
  const runNx = (args: string[]) =>
    new Command(process.execPath, [nxBin, ...args], {
      cwd: root,
      env: environment,
      clock: globalThis,
    }).run({ signal });
  const targets = async (project: string) => {
    const shown = await nx('show', 'project', project, '--json');
    assert.equal(shown.exitCode, 0, shown.output);
    const configuration: { targets: Record<string, Target> } = JSON.parse(
      shown.stdout,
    );
    return configuration.targets;
  };
  const owned = resources.move();
  return {
    path: root,
    nx,
    targets,
    write,
    lockfile: (lockfilePackages: Record<string, object>) =>
      write('package-lock.json', lockfile(lockfilePackages)),
    read: (path: string) => readFile(join(root, path), 'utf8'),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
