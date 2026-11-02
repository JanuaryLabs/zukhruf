import { basename } from 'node:path';

import type { Commit } from './commit.ts';
import { type Outcome, Step } from './step.ts';

// The places that pick a Node or npm version, and the numeric forms each one
// accepts. lts/*, node:lts-* and npm@latest name no number.
const NUMERIC_NODE_VERSION = /^\s*-?\s*node-version:\s*['"]?v?\d/;
const NUMERIC_NODE_IMAGE = /^\s*FROM\s+(--\S+\s+)*node:v?\d/i;
const NUMERIC_NPM = /\bnpm@\d/;
const NUMERIC_NVMRC = /^\s*v?\d/;

function isWorkflow(path: string): boolean {
  return path.startsWith('.github/') && /\.ya?ml$/.test(path);
}

function isDockerfile(path: string): boolean {
  return /(^|\.)Dockerfile(\.|$)/.test(basename(path));
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function linePatterns(path: string): readonly RegExp[] | undefined {
  if (basename(path) === '.nvmrc') return [NUMERIC_NVMRC];
  if (isWorkflow(path)) return [NUMERIC_NODE_VERSION, NUMERIC_NPM];
  if (isDockerfile(path)) return [NUMERIC_NODE_IMAGE, NUMERIC_NPM];
  return undefined;
}

// Each line of `source` that any of `patterns` matches, as `path:line  text`.
function matchingLines(
  path: string,
  source: string,
  patterns: readonly RegExp[],
) {
  return source
    .split('\n')
    .flatMap((text, index) =>
      patterns.some((pattern) => pattern.test(text))
        ? [`${path}:${index + 1}  ${text.trim()}`]
        : [],
    );
}

// A package.json names no Node or npm version: no engines range, no
// packageManager number, no allowScripts key pinned to a version.
function manifestPins(path: string, source: string): string[] {
  const manifest: unknown = JSON.parse(source);
  if (!isObject(manifest)) return [];
  const pins: string[] = [];
  if ('engines' in manifest && isObject(manifest.engines))
    for (const engine of ['node', 'npm'])
      if (engine in manifest.engines) pins.push(`${path}  engines.${engine}`);
  if (
    'packageManager' in manifest &&
    typeof manifest.packageManager === 'string' &&
    /@\d/.test(manifest.packageManager)
  )
    pins.push(`${path}  packageManager ${manifest.packageManager}`);
  if ('allowScripts' in manifest && isObject(manifest.allowScripts))
    for (const key of Object.keys(manifest.allowScripts))
      if (/.@\d/.test(key)) pins.push(`${path}  allowScripts ${key}`);
  return pins;
}

// Refuses a staged Node or npm version written as a number, so every repo
// stays on the current LTS and the latest npm. Other files that hold versions
// stay out: package-lock.json keeps its dependencies' engines, EAS requires an
// exact build node in eas.json, and dated docs record what ran.
export class NoNumericPins extends Step<Commit> {
  readonly name = 'pins';

  async run(commit: Commit): Promise<Outcome> {
    const pins: string[] = [];
    for (const path of await commit.files()) {
      if (basename(path) === 'package.json') {
        pins.push(...manifestPins(path, await commit.blob(path)));
        continue;
      }
      const patterns = linePatterns(path);
      if (patterns === undefined) continue;
      pins.push(...matchingLines(path, await commit.blob(path), patterns));
    }
    if (pins.length === 0) return this.pass('no staged Node or npm pin');
    return this.fail(
      [
        'Node and npm stay on the current LTS and the latest npm, never a number:',
        ...pins.map((pin) => `  ${pin}`),
        'Use lts/* (.nvmrc, setup-node), node:lts-* (images) and npm@latest, and drop engines.',
      ].join('\n'),
    );
  }
}
