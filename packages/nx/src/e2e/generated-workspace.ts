// The steps that smoke.ts and upgrade.ts share: a workspace of the standard
// made with create-nx-workspace and the generators of one published version,
// as a person makes it from the README (packages/nx ADR 0020).
import { join } from 'node:path';

import { Command, ExitError, StartError } from '@zukhruf/process';

/** The folder name, and so the scope `@acme` of every workspace made here. */
const name = 'acme';
/** The db package that the prisma generator writes into the workspace. */
export const dbProject = `@${name}/db`;

/** A step of the generated workspace failed. The message names the step and its command. */
export class StepFailed extends Error {}

/**
 * The environment of each child process.
 *
 * - `npx nx run` exports the configuration of this repository's npm as
 *   `npm_config_*` (`strict-allow-scripts` among them), and npm reads those
 *   before the `.npmrc` of the generated workspace. Without them, the
 *   workspace's own `.npmrc` decides, as in a person's shell.
 * - No Nx daemon: it would stay alive after the folder is removed.
 * - A Git identity: a CI runner has none, and create-nx-workspace and the
 *   commit of the smoke test write commits.
 */
const environment: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('npm_')),
  ),
  NX_DAEMON: 'false',
  GIT_AUTHOR_NAME: 'zukhruf e2e',
  GIT_AUTHOR_EMAIL: 'e2e@zukhruf.invalid',
  GIT_COMMITTER_NAME: 'zukhruf e2e',
  GIT_COMMITTER_EMAIL: 'e2e@zukhruf.invalid',
};

/**
 * Runs one step with its output on this terminal. stdin is closed, so no tool
 * waits for an answer: create-nx-workspace and `nx migrate` ask only on a TTY.
 */
export async function step(
  title: string,
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  console.log(`\n==> ${title}\n    ${command} ${args.join(' ')}`);
  const started = await new Command(command, args, {
    cwd,
    env: environment,
    clock: globalThis,
  })
    .start({ stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
    .catch((error: unknown) => {
      if (!(error instanceof StartError)) throw error;
      throw new StepFailed(`${title}: ${error.message}`, { cause: error });
    });
  const end = await started.ended;
  if (end.exitCode !== 0) {
    const failure = new ExitError(`${command} ${args.join(' ')}`, end);
    throw new StepFailed(`${title}, in ${cwd}: ${failure.message}.`, {
      cause: failure,
    });
  }
}

/** Runs a command that prints a value, and returns its standard output. */
export async function read(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const run = await new Command(command, args, {
    cwd,
    env: environment,
    clock: globalThis,
  }).run();
  if (run.exitCode !== 0) {
    throw new ExitError(`${command} ${args.join(' ')}`, run);
  }
  return run.stdout;
}

/** The version that the `latest` tag of @zukhruf/nx names on npm. */
export async function latestVersion(cwd: string): Promise<string> {
  return (await read('npm', ['view', '@zukhruf/nx', 'version'], cwd)).trim();
}

/**
 * Makes the workspace of the standard in `parent`, with every generator that
 * a repo of the standard runs except dokploy: a backend, a web app, their
 * pair, a db package wired into the backend, sign-in on both, and a UI
 * package. Returns the workspace root.
 */
export async function generateWorkspace(
  parent: string,
  version: string,
): Promise<string> {
  const root = join(parent, name);
  await step(
    `Create the workspace with @zukhruf/nx@${version}`,
    'npx',
    [
      '--yes',
      'create-nx-workspace@latest',
      name,
      `--preset=@zukhruf/nx@${version}`,
      '--pm=npm',
      '--nxCloud=skip',
      '--aiAgents=none',
    ],
    parent,
  );
  const generators: [string, string[]][] = [
    ['node-app', ['apps/backend']],
    ['react-app', ['apps/web']],
    ['pair', ['--api', 'apps/backend', '--web', 'apps/web']],
    ['prisma', ['packages/db', '--backend', 'apps/backend']],
    [
      'auth',
      ['--backend', 'apps/backend', '--db', 'packages/db', '--web', 'apps/web'],
    ],
    ['ui-package', ['packages/ui', '--importPath', `@${name}/ui`]],
  ];
  for (const [generator, options] of generators) {
    await step(
      `Run the ${generator} generator`,
      'npx',
      ['nx', 'g', `@zukhruf/nx:${generator}`, ...options],
      root,
    );
  }
  await step('Install the dependencies', 'npm', ['install'], root);
  await step('Sync the workspace', 'npx', ['nx', 'sync'], root);
  return root;
}
