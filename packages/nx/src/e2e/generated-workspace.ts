// The steps that smoke.ts and upgrade.ts share: a workspace of the standard
// made with create-nx-workspace and the generators of one published version,
// as a person makes it from the README (packages/nx ADR 0020).
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

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
export function step(
  title: string,
  command: string,
  args: string[],
  cwd: string,
): void {
  console.log(`\n==> ${title}\n    ${command} ${args.join(' ')}`);
  const run = spawnSync(command, args, {
    cwd,
    env: environment,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (run.error !== undefined) {
    throw new StepFailed(`${title}: ${run.error.message}`);
  }
  if (run.status !== 0) {
    const ending =
      run.status === null ? `signal ${run.signal}` : `exit code ${run.status}`;
    throw new StepFailed(
      `${title}: \`${command} ${args.join(' ')}\` in ${cwd} ended with ${ending}.`,
    );
  }
}

/** Runs a command that prints a value, and returns its standard output. */
export function read(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** The version that the `latest` tag of @zukhruf/nx names on npm. */
export function latestVersion(cwd: string): string {
  return read('npm', ['view', '@zukhruf/nx', 'version'], cwd).trim();
}

/**
 * Makes the workspace of the standard in `parent`, with every generator that
 * a repo of the standard runs except dokploy: a backend, a web app, their
 * pair, a db package wired into the backend, sign-in on both, and a UI
 * package. Returns the workspace root.
 */
export function generateWorkspace(parent: string, version: string): string {
  const root = join(parent, name);
  step(
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
    step(
      `Run the ${generator} generator`,
      'npx',
      ['nx', 'g', `@zukhruf/nx:${generator}`, ...options],
      root,
    );
  }
  step('Install the dependencies', 'npm', ['install'], root);
  step('Sync the workspace', 'npx', ['nx', 'sync'], root);
  return root;
}
