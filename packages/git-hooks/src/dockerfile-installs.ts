import { basename } from 'node:path';

import type { Commit } from './commit.ts';
import { type Outcome, Step } from './step.ts';

// A copy of `isDockerfile` in no-numeric-pins.ts (docs/copied-code.md).
function isDockerfile(path: string): boolean {
  return /(^|\.)Dockerfile(\.|$)/.test(basename(path));
}

// npm's names for `npm install` and for `npm install-test`, which installs
// first (npm 12, lib/utils/cmd-list.js aliases).
const NPM_INSTALL = new Set([
  'install',
  'install-test',
  'it',
  'i',
  'in',
  'ins',
  'inst',
  'insta',
  'instal',
  'isnt',
  'isnta',
  'isntal',
  'isntall',
  'add',
]);

// The script of each RUN instruction, with the line where it starts, as
// Docker reads it: continuation lines are joined, and a comment or an empty
// line inside them is dropped; flags such as --mount come before the script;
// the exec form is a JSON array; a heredoc holds the script in its body.
function runScripts(dockerfile: string): { line: number; script: string }[] {
  const lines = dockerfile.split(/\r?\n/);
  const scripts: { line: number; script: string }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const start = index;
    let text = (lines[index] ?? '').trimEnd();
    if (!/^\s*RUN\s/i.test(text)) continue;
    while (text.endsWith('\\') && index + 1 < lines.length) {
      index++;
      const next = lines[index] ?? '';
      text = /^\s*(#|$)/.test(next)
        ? text
        : `${text.slice(0, -1)} ${next.trimEnd()}`;
    }
    const rest = text.replace(/^\s*RUN\s+(--\S+\s+)*/i, '');
    const heredoc = /^<<(-?)["']?(\w+)["']?/.exec(rest);
    if (heredoc !== null) {
      const [, dash, delimiter] = heredoc;
      const body: string[] = [];
      while (index + 1 < lines.length) {
        index++;
        const line = lines[index] ?? '';
        if ((dash === '-' ? line.trim() : line) === delimiter) break;
        body.push(line);
      }
      scripts.push({ line: start + 1, script: body.join('\n') });
      continue;
    }
    scripts.push({ line: start + 1, script: execForm(rest) ?? rest });
  }
  return scripts;
}

// The words of an exec form, `["npm", "ci"]`, joined by spaces.
function execForm(rest: string): string | undefined {
  if (!rest.startsWith('[')) return undefined;
  try {
    const words: unknown = JSON.parse(rest);
    return Array.isArray(words) ? words.join(' ') : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// Whether one simple command installs packages that no lockfile pins: an
// npm install, or an install or add of yarn, pnpm or bun. A global install
// of a tool installs no dependency of the project.
function installsWithoutLockfile(command: string): boolean {
  const words = command.split(/\s+/).filter((word) => word !== '');
  while (/^\w+=/.test(words[0] ?? '')) words.shift();
  const [program = '', ...args] = words;
  const subcommand = args.find((arg) => !arg.startsWith('-'));
  const global = args.some((arg) =>
    ['-g', '--global', '--location=global'].includes(arg),
  );
  switch (basename(program)) {
    case 'npm':
      return subcommand !== undefined && NPM_INSTALL.has(subcommand) && !global;
    case 'yarn':
      return (
        subcommand === undefined || ['install', 'add'].includes(subcommand)
      );
    case 'pnpm':
    case 'bun':
      return (
        subcommand !== undefined &&
        ['install', 'i', 'add'].includes(subcommand) &&
        !global
      );
    default:
      return false;
  }
}

// Refuses a staged Dockerfile that installs packages without the lockfile.
// `npm install` in an image resolves the ranges of package.json at build
// time, so the image runs versions that no commit names. `npm ci` installs
// what package-lock.json holds, or fails.
export class DockerfileInstallsFromLockfile extends Step<Commit> {
  readonly name = 'docker';

  async run(commit: Commit): Promise<Outcome> {
    const tree = await commit.tree();
    const installs: string[] = [];
    for (const entry of await commit.changes()) {
      if (entry.change === 'deleted' || entry.kind !== 'file') continue;
      if (!isDockerfile(entry.path)) continue;
      const dockerfile = await tree.read(entry.path);
      if (dockerfile === undefined) continue;
      for (const { line, script } of runScripts(dockerfile))
        for (const command of script.split(/&&|\|\||[;|\n]/))
          if (installsWithoutLockfile(command))
            installs.push(`${entry.path}:${line}  ${command.trim()}`);
    }
    if (installs.length === 0)
      return this.pass('no staged Dockerfile installs without the lockfile');
    return this.fail(
      [
        'A Dockerfile installs packages from package-lock.json only:',
        ...installs.map((install) => `  ${install}`),
        'COPY package.json and package-lock.json, then RUN npm ci (npm ci --omit=dev for a runtime image). A global tool may use npm install -g.',
      ].join('\n'),
    );
  }
}
