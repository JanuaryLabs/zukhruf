import { spawnSync } from 'node:child_process';

const devkit = import.meta.resolve('@nx/devkit');

/**
 * Builds and caches the Nx project graph of the workspace at `root`, the way
 * `nx` does before it lints. Nx's dependency-checks reads only that cache and
 * skips silently without it. Runs in its own process because Nx fixes its
 * workspace root from the working directory once it loads.
 */
export function buildProjectGraph(root: string): void {
  const run = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await (await import(${JSON.stringify(devkit)})).createProjectGraphAsync({ exitOnError: false });`,
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  if (run.status !== 0) {
    throw new Error(`Building the project graph failed:\n${run.stderr}`);
  }
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
