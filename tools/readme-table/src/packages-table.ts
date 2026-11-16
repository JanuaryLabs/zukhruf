import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { format, resolveConfig } from 'prettier';

const execFileAsync = promisify(execFile);

export const START = '<!-- packages-table:start -->';
export const END = '<!-- packages-table:end -->';
export const STALE = [
  'The Packages table of README.md is not the one that the package.json descriptions give.',
  'Stage each changed package.json, run npx nx run readme-table:generate, and stage README.md. A package states what it does in its package.json description.',
].join('\n');

interface Row {
  readonly name: string;
  readonly folder: string;
  readonly description: string;
  readonly private: boolean;
}

// The README with its Packages table rebuilt from the package.json of each
// workspace package, so a package's description is the one home of its text.
// The manifests come from the git index, not the disk: a package that another
// session has on disk but did not stage never enters someone else's table.
export async function generatedReadme(
  workspace: string,
  readme: string,
): Promise<string> {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end < start)
    throw new Error(`README.md has no ${START} … ${END} section`);
  const rows = await indexedRows(workspace);
  const table = [
    '| Package | What it does |',
    '| --- | --- |',
    ...rows.map(
      (row) =>
        `| [\`${row.name}\`](./${row.folder}) | ${row.description}${row.private ? ' Private: reached through a workspace path.' : ''} |`,
    ),
  ].join('\n');
  const filepath = join(workspace, 'README.md');
  return format(
    `${readme.slice(0, start + START.length)}\n\n${table}\n\n${readme.slice(end)}`,
    { ...(await resolveConfig(filepath)), filepath },
  );
}

// The staged copy of a file: the version that a commit or a CI checkout holds.
export async function indexed(
  workspace: string,
  path: string,
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['show', `:${path}`], {
    cwd: workspace,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

// The workspaces of the root package.json say where packages live; apps have
// a table of their own.
async function indexedRows(workspace: string): Promise<Row[]> {
  const pathspecs = workspaces(await indexed(workspace, 'package.json'))
    .filter((glob) => glob.startsWith('packages/'))
    .map((glob) => `:(glob)${glob}/package.json`);
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '-z', '--', ...pathspecs],
    { cwd: workspace },
  );
  const rows: Row[] = [];
  for (const path of stdout.split('\0').filter((entry) => entry !== ''))
    rows.push(row(path, await indexed(workspace, path)));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function row(path: string, source: string): Row {
  const manifest: unknown = JSON.parse(source);
  if (
    typeof manifest === 'object' &&
    manifest !== null &&
    'name' in manifest &&
    typeof manifest.name === 'string' &&
    'description' in manifest &&
    typeof manifest.description === 'string'
  )
    return {
      name: manifest.name,
      folder: path.slice(0, -'/package.json'.length),
      description: manifest.description,
      private: 'private' in manifest && manifest.private === true,
    };
  throw new Error(`${path} needs a name and a description`);
}

function workspaces(source: string): string[] {
  const manifest: unknown = JSON.parse(source);
  if (
    typeof manifest === 'object' &&
    manifest !== null &&
    'workspaces' in manifest &&
    Array.isArray(manifest.workspaces)
  )
    return manifest.workspaces.filter(
      (glob): glob is string => typeof glob === 'string',
    );
  throw new Error('the root package.json has no workspaces array');
}
