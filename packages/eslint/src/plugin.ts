import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';

import type { ESLint, Linter } from 'eslint';

import { base } from './base/config.ts';
import type { Concept } from './concept.ts';
import { diagnostics } from './diagnostics/config.ts';
import { env } from './environment/config.ts';
import { hono } from './hono/config.ts';
import { nxProjectJson } from './nx-project/config.ts';
import { packagedApp } from './packaged-app/config.ts';
import { pulumi } from './pulumi/config.ts';
import { reactRouter } from './react-router/config.ts';
import { react } from './react/config.ts';
import { tailwind } from './tailwind/config.ts';
import { tests } from './test-files/config.ts';
import { isRecord } from './unknown-values.ts';

const concepts: Concept[] = [
  base,
  tests,
  diagnostics,
  env,
  packagedApp,
  react,
  reactRouter,
  hono,
  tailwind,
  pulumi,
  nxProjectJson,
];

function packageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(findPackageJSON(import.meta.url) ?? '', 'utf8'),
  );
  return isRecord(manifest) && typeof manifest['version'] === 'string'
    ? manifest['version']
    : '0.0.0';
}

const configs: Record<string, Linter.Config[]> = {};

const plugin = {
  meta: {
    name: '@zukhruf/eslint',
    version: packageVersion(),
    namespace: 'zukhruf',
  },
  rules: Object.fromEntries(
    concepts.flatMap((concept) => Object.entries(concept.rules)),
  ),
  configs,
} satisfies ESLint.Plugin;

for (const concept of concepts) {
  configs[concept.name] = concept.config({ zukhruf: plugin });
}

export default plugin;
