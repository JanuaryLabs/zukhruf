import type { ESLint, Linter } from 'eslint';

import manifest from '../package.json' with { type: 'json' };
import { base } from './base/config.ts';
import { betterAuth } from './better-auth/config.ts';
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
import { tsconfig } from './tsconfig/config.ts';

const concepts: Concept[] = [
  base,
  tests,
  diagnostics,
  env,
  packagedApp,
  react,
  reactRouter,
  hono,
  betterAuth,
  tailwind,
  pulumi,
  nxProjectJson,
  tsconfig,
];

const configs: Record<string, Linter.Config[]> = {};

const plugin = {
  meta: {
    name: '@zukhruf/eslint',
    version: manifest.version,
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
