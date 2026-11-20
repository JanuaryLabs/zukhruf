import type { ESLint, Linter } from 'eslint';

import manifest from '../package.json' with { type: 'json' };
import { base } from './base/config.ts';
import { betterAuth } from './better-auth/config.ts';
import type { Concept } from './concept.ts';
import { diagnostics } from './diagnostics/config.ts';
import { env } from './environment/config.ts';
import { githubActions } from './github-actions/config.ts';
import { hono } from './hono/config.ts';
import { nxProjectJson } from './nx-project/config.ts';
import { packagedApp } from './packaged-app/config.ts';
import { pulumi } from './pulumi/config.ts';
import { reactRouter } from './react-router/config.ts';
import { shadcn } from './react/config.ts';
import { tailwind } from './tailwind/config.ts';
import { tests } from './test-files/config.ts';
import { tsconfig } from './tsconfig/config.ts';

const concepts: Concept[] = [
  base,
  tests,
  diagnostics,
  env,
  packagedApp,
  shadcn,
  reactRouter,
  hono,
  betterAuth,
  tailwind,
  pulumi,
  nxProjectJson,
  tsconfig,
  githubActions,
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

// `react` is the old name of `shadcn`, kept for one release (#4990). It is
// not enumerable, so the plugin lists each config once.
Object.defineProperty(configs, 'react', {
  get() {
    process.emitWarning(
      "The config zukhruf/react is now zukhruf/shadcn. Use zukhruf.configs['shadcn'] or extends: ['zukhruf/shadcn']; the name react goes away in the next release.",
      { type: 'DeprecationWarning', code: 'ZUKHRUF_ESLINT_REACT_CONFIG' },
    );
    return configs['shadcn'];
  },
});

export default plugin;
