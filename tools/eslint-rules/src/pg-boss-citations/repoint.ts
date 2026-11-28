// Moves the pg-boss line citations of a package from the version that its
// pg-boss-citations.json records to the installed pg-boss, which must be the
// pinned one.
//
//   node tools/eslint-rules/src/pg-boss-citations/repoint.ts <package dir> [--checked]
//
// A cited line that is in a block the new version changed is listed for a hand
// check and not moved; the record then stays as it is and the exit code is 1.
// After the hand check, `--checked` writes the record. Lines that `git diff
// HEAD` adds, and untracked files, are skipped: they cite the new version
// already.
import { globSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { Linter } from 'eslint';
import * as prettier from 'prettier';
import tseslint from 'typescript-eslint';

import { TemporaryFiles } from '@zukhruf/fs';
import { Command, ExitError } from '@zukhruf/process';

import { type Citation, citations, commentCitations } from './citations.ts';

const RECORD = 'pg-boss-citations.json';

/** A line of an old dist file → its line in the new file, for the lines the diff keeps. */
type LineMap = ReadonlyMap<number, number>;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { checked: { type: 'boolean', default: false } },
});
const [packageArgument] = positionals;
if (packageArgument === undefined) {
  throw new Error('Usage: repoint.ts <package dir> [--checked]');
}
const packageDir = resolve(packageArgument);
const recordPath = join(packageDir, RECORD);

const pinned = pinnedVersion(join(packageDir, 'package.json'));
const installedManifest = findPackageJSON(
  'pg-boss',
  pathToFileURL(join(packageDir, 'package.json')),
);
if (installedManifest === undefined) {
  throw new Error(
    `pg-boss is not installed for ${packageDir}. Run npm install.`,
  );
}
const to = versionOf(installedManifest);
const from = recordedVersion(recordPath);

if (to !== pinned) {
  console.error(
    `pg-boss ${to} is installed, but package.json pins ${pinned}. Run npm install, then run this again.`,
  );
  process.exitCode = 1;
} else if (from === to) {
  console.log(
    `The citations name the lines of pg-boss ${to} already: moved 0.`,
  );
} else if (values.checked) {
  await writeRecord(to);
  console.log(`Recorded pg-boss ${to} in ${RECORD}.`);
} else {
  await using folder = await new TemporaryFiles().directory('pg-boss-repoint-');
  const oldDist = await unpack(from, folder.path);
  const newDist = join(dirname(installedManifest), 'dist');
  const maps = await lineMaps(oldDist, newDist);
  const skipped = await linesChangedSinceHead(packageDir);

  const { moved, skippedCount, flags, changed } = await moveCitations(
    maps,
    skipped,
  );

  for (const flag of flags) console.log(flag);
  console.log(
    `pg-boss ${from} → ${to}: moved ${moved} in ${changed.length} files, flagged ${flags.length}, skipped ${skippedCount} as changed since HEAD.`,
  );
  if (flags.length === 0) {
    await writeRecord(to);
    console.log(`Recorded pg-boss ${to} in ${RECORD}.`);
  } else {
    console.log(
      `Cite the flagged lines of pg-boss ${to} by hand, then run this again with --checked to record ${to}.`,
    );
    process.exitCode = 1;
  }
}

/** Re-points the citations of each .ts and .md file of the package that are not changed since HEAD. */
async function moveCitations(
  maps: ReadonlyMap<string, LineMap>,
  skipped: ReadonlyMap<string, ReadonlySet<number> | 'all'>,
) {
  let moved = 0;
  let skippedCount = 0;
  const flags: string[] = [];
  const changed: string[] = [];
  const files = globSync('**/*.{ts,md}', {
    cwd: packageDir,
    exclude: (name) => name === 'node_modules' || name === 'dist',
  }).sort();
  for (const file of files) {
    const path = join(packageDir, file);
    const text = readFileSync(path, 'utf8');
    const skip = skipped.get(file);
    const replacements: { citation: Citation; range: string }[] = [];
    for (const citation of citationsOf(path, text)) {
      const line = lineOf(text, citation.start);
      if (skip === 'all' || skip?.has(line)) {
        skippedCount += 1;
        continue;
      }
      const map = maps.get(citation.file);
      const first = map?.get(citation.first);
      const last = map?.get(citation.last);
      if (first === undefined || last === undefined) {
        flags.push(
          map === undefined
            ? `${file}:${line}: ${citation.file}:${citation.range}: ${citation.file} is not in the dists of both ${from} and ${to}.`
            : `${file}:${line}: ${citation.file}:${citation.range} is in a block that pg-boss ${to} changed.`,
        );
        continue;
      }
      const range = citation.range.includes('-')
        ? `${first}-${last}`
        : `${first}`;
      if (range !== citation.range) {
        moved += 1;
        replacements.push({ citation, range });
      }
    }
    if (replacements.length === 0) continue;
    let next = text;
    for (const { citation, range } of replacements.toReversed()) {
      next = next.slice(0, citation.start) + range + next.slice(citation.end);
    }
    writeFileSync(path, await format(path, next));
    changed.push(file);
  }
  return { moved, skippedCount, flags, changed };
}

function pinnedVersion(manifest: string): string {
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  const dependencies =
    typeof parsed === 'object' && parsed !== null && 'dependencies' in parsed
      ? parsed.dependencies
      : undefined;
  const pin =
    typeof dependencies === 'object' &&
    dependencies !== null &&
    'pg-boss' in dependencies
      ? dependencies['pg-boss']
      : undefined;
  if (typeof pin !== 'string') {
    throw new Error(`${manifest} has no pg-boss dependency`);
  }
  return pin;
}

function versionOf(manifest: string): string {
  return String(JSON.parse(readFileSync(manifest, 'utf8')).version);
}

function recordedVersion(record: string): string {
  const parsed: unknown = JSON.parse(readFileSync(record, 'utf8'));
  const version =
    typeof parsed === 'object' && parsed !== null && 'pg-boss' in parsed
      ? parsed['pg-boss']
      : undefined;
  if (typeof version !== 'string') {
    throw new Error(`${record} records no pg-boss version`);
  }
  return version;
}

async function writeRecord(version: string): Promise<void> {
  writeFileSync(
    recordPath,
    await format(recordPath, JSON.stringify({ 'pg-boss': version })),
  );
}

async function format(path: string, text: string): Promise<string> {
  const options = await prettier.resolveConfig(path);
  return prettier.format(text, { ...options, filepath: path });
}

/** Unpacks the tarball of pg-boss `version` into `into`, and returns its dist. Its code is never run. */
async function unpack(version: string, into: string): Promise<string> {
  // npm runs in the package, so the registry of the workspace's .npmrc applies.
  const npm = new Command(
    'npm',
    [
      'pack',
      `pg-boss@${version}`,
      '--loglevel=warn',
      '--pack-destination',
      into,
    ],
    { env: process.env, clock: globalThis, cwd: packageDir },
  );
  const packed = await (
    await npm.start({ stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' })
  ).ended;
  // Its stderr went to the terminal, so the error has only the end.
  if (packed.exitCode !== 0) throw new ExitError('npm', packed);
  // The folder is new, so the tarball is its only file.
  const [filename] = readdirSync(into);
  if (filename === undefined) {
    throw new Error(`npm pack pg-boss@${version} wrote no tarball`);
  }
  const tar = await run('tar', ['-xzf', join(into, filename), '-C', into]);
  if (tar.exitCode !== 0) throw new ExitError('tar', tar);
  return join(into, 'package', 'dist');
}

/**
 * The line map of each .js file of the old dist that the new dist also has.
 * The lines outside the hunks of `git diff -U0` are the lines both files
 * share, as the equal blocks of a difflib SequenceMatcher are.
 */
async function lineMaps(
  oldDist: string,
  newDist: string,
): Promise<Map<string, LineMap>> {
  const newFiles = new Set(jsFiles(newDist));
  const maps = new Map<string, LineMap>();
  for (const file of jsFiles(oldDist)) {
    if (!newFiles.has(file)) continue;
    const oldFile = join(oldDist, file);
    const diff = await run('git', [
      'diff',
      '--no-index',
      '--no-color',
      '--no-ext-diff',
      '--diff-algorithm=myers',
      '-U0',
      oldFile,
      join(newDist, file),
    ]);
    // git diff --no-index exits 1 when the files differ.
    if (diff.exitCode !== 0 && diff.exitCode !== 1)
      throw new ExitError('git', diff);
    maps.set(file, keptLines(diff.stdout, lineCount(oldFile)));
  }
  return maps;
}

function keptLines(diff: string, oldLines: number): Map<number, number> {
  const removed = new Set<number>();
  // Each hunk shifts the old lines after it by `delta`.
  const shifts: { from: number; delta: number }[] = [];
  for (const hunk of diff.matchAll(
    /^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@/gm,
  )) {
    const oldStart = Number(hunk.groups?.['oldStart']);
    const oldCount = Number(hunk.groups?.['oldCount'] ?? '1');
    const newStart = Number(hunk.groups?.['newStart']);
    const newCount = Number(hunk.groups?.['newCount'] ?? '1');
    for (let line = oldStart; line < oldStart + oldCount; line++) {
      removed.add(line);
    }
    // With a count of 0, the start is the line before the hunk.
    const oldAfter = oldCount === 0 ? oldStart + 1 : oldStart + oldCount;
    const newAfter = newCount === 0 ? newStart + 1 : newStart + newCount;
    shifts.push({ from: oldAfter, delta: newAfter - oldAfter });
  }
  const kept = new Map<number, number>();
  let delta = 0;
  let next = 0;
  for (let line = 1; line <= oldLines; line++) {
    while (next < shifts.length && (shifts[next]?.from ?? 0) <= line) {
      delta = shifts[next]?.delta ?? delta;
      next += 1;
    }
    if (!removed.has(line)) kept.set(line, line + delta);
  }
  return kept;
}

function jsFiles(dist: string): string[] {
  return readdirSync(dist, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js'))
    .map((file) => file.replaceAll('\\', '/'));
}

function lineCount(file: string): number {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** The lines of each file of the package that changed since HEAD: added lines, or 'all' for an untracked file. */
async function linesChangedSinceHead(
  cwd: string,
): Promise<Map<string, ReadonlySet<number> | 'all'>> {
  const git = async (...args: string[]) => {
    const completed = await run('git', args, cwd);
    if (completed.exitCode !== 0) throw new ExitError('git', completed);
    return completed.stdout;
  };
  const changed = new Map<string, Set<number> | 'all'>();
  let current: Set<number> | undefined;
  for (const line of (
    await git(
      'diff',
      '--relative',
      '--no-color',
      '--no-ext-diff',
      '-U0',
      'HEAD',
      '--',
      '.',
    )
  ).split('\n')) {
    if (line.startsWith('+++ b/')) {
      current = new Set();
      changed.set(line.slice('+++ b/'.length), current);
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = Number(hunk[2] ?? '1');
      for (let added = start; added < start + count; added++) {
        current.add(added);
      }
    }
  }
  for (const file of (await git('ls-files', '--others', '--exclude-standard'))
    .split('\n')
    .filter(Boolean)) {
    changed.set(file, 'all');
  }
  return changed;
}

/** The citations that the lint rule reads in a .ts file, or all of a Markdown file. */
function citationsOf(path: string, text: string): Citation[] {
  if (path.endsWith('.md')) return citations(text);
  // A flat config lints only files under its cwd that a `files` names.
  const linter = new Linter({ cwd: packageDir });
  const [fatal] = linter.verify(
    text,
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    { filename: path },
  );
  if (fatal?.fatal) throw new Error(`${path}: ${fatal.message}`);
  return commentCitations(linter.getSourceCode());
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = text.indexOf('\n'); index !== -1 && index < offset;) {
    line += 1;
    index = text.indexOf('\n', index + 1);
  }
  return line;
}

function run(file: string, args: readonly string[], cwd?: string) {
  return new Command(file, args, {
    env: process.env,
    clock: globalThis,
    ...(cwd === undefined ? {} : { cwd }),
  }).run();
}
