import { Command, ExitError } from '@zukhruf/process';

const devkit = import.meta.resolve('@nx/devkit');

/**
 * Builds and caches the Nx project graph of the workspace at `root`, the way
 * `nx` does before it lints. Nx's dependency-checks reads only that cache and
 * skips silently without it. Runs in its own process because Nx fixes its
 * workspace root from the working directory once it loads.
 */
export async function buildProjectGraph(root: string): Promise<void> {
  const run = await new Command(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await (await import(${JSON.stringify(devkit)})).createProjectGraphAsync({ exitOnError: false });`,
    ],
    {
      env: process.env,
      clock: globalThis,
      cwd: root,
      name: 'nx project graph',
    },
  ).run();
  if (run.exitCode !== 0) throw new ExitError('nx project graph', run);
}

/**
 * An nx.json for a fixture. Nx reads imports from source files only when the
 * root package.json lists an @nx package or nx.json configures @nx/js; a
 * fixture has no such package. Without a daemon, building the graph leaves no
 * process behind.
 */
export const NX_JSON = JSON.stringify({
  useDaemonProcess: false,
  pluginsConfig: { '@nx/js': { analyzeSourceFiles: true } },
});
