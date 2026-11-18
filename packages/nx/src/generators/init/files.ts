// The content of each root file that a generator writes (README, monorepo
// standard). Each is a string in a .ts module, so tsc puts it in dist with no
// copy step (ADR 0009).

export const gitignore = `# Dependencies and Nx state
node_modules/
.nx/

# Build and test output
dist/
out-tsc/
coverage/
test-results.xml
*.tsbuildinfo
vite.config.*.timestamp*
vitest.config.*.timestamp*

# Generated sdk-it clients: only the committed stubs stay
**/.sdk-it/*
!**/.sdk-it/package.json
!**/.sdk-it/tsconfig.json

# Local configuration
.env*
!.env.example

# Editors and operating systems
.DS_Store
.idea/
.vscode/*
!.vscode/extensions.json
!.vscode/settings.json
`;

export const prettierignore = `node_modules
.nx
coverage
dist
out-tsc
package-lock.json
*.tsbuildinfo
.sdk-it
`;

export const npmrc = `legacy-peer-deps=false
save-exact=true
strict-allow-scripts=true
`;

export const nvmrc = 'lts/*\n';

export const gitattributes = '* text=auto eol=lf\n';

export const editorconfig = `root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
`;

export const tsconfigBase = {
  compilerOptions: {
    allowImportingTsExtensions: true,
    composite: true,
    declaration: true,
    declarationMap: true,
    emitDeclarationOnly: true,
    erasableSyntaxOnly: true,
    forceConsistentCasingInFileNames: true,
    importHelpers: true,
    isolatedModules: true,
    lib: ['ESNext'],
    module: 'ESNext',
    moduleResolution: 'Bundler',
    noEmitOnError: true,
    noFallthroughCasesInSwitch: true,
    noImplicitOverride: true,
    noImplicitReturns: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    strict: true,
    target: 'ESNext',
    useUnknownInCatchVariables: true,
    verbatimModuleSyntax: true,
  },
};

export const tsconfigSolution = {
  extends: './tsconfig.base.json',
  compileOnSave: false,
  files: [],
  references: [],
};

export function prettierrc(scope: string) {
  return {
    singleQuote: true,
    // The first two entries keep the boot imports of a backend (./env,
    // ./startup) before all others.
    importOrder: [
      '^\\./env(\\.ts)?$',
      '^\\./startup(\\.ts)?$',
      '^node:(.*)$',
      '<THIRD_PARTY_MODULES>',
      `^@${scope}/(.*)$`,
      '^[./]',
    ],
    plugins: ['@trivago/prettier-plugin-sort-imports'],
    importOrderSeparation: true,
    importOrderSortSpecifiers: true,
    overrides: [
      {
        files: ['*.css', '*.scss', '*.less'],
        options: { singleQuote: false },
      },
    ],
  };
}

export const eslintConfig = `import nx from '@nx/eslint-plugin';
import zukhruf from '@zukhruf/eslint';
import modernNode from '@zukhruf/eslint/modern-node';
import { manifest } from '@zukhruf/eslint/nx';
import { defineConfig } from 'eslint/config';

// Modern Node is for code that runs on Node. A browser bundle stays out. Each
// project has its own eslint.config.mjs that spreads the default export, so a
// Node project spreads this block too.
export const modernNodeRecommended = defineConfig({
  plugins: { 'modern-node': modernNode },
  extends: ['modern-node/recommended'],
});

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    // Flat config never reads .gitignore, so build output is listed here.
    ignores: [
      '**/.nx',
      '**/coverage',
      '**/dist',
      '**/node_modules',
      '**/out-tsc',
      '**/*.tsbuildinfo',
      '**/vite.config.*.timestamp*',
      '**/vitest.config.*.timestamp*',
      '**/.sdk-it',
    ],
  },
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          depConstraints: [{ sourceTag: '*', onlyDependOnLibsWithTags: ['*'] }],
        },
      ],
    },
  },
  ...zukhruf.configs['base'],
  ...zukhruf.configs['tests'],
  ...zukhruf.configs['diagnostics'],
  ...zukhruf.configs['env'],
  ...zukhruf.configs['nx-project-json'],
  ...manifest.configs.recommended,
  // The files that this config lints itself, and the config files of each
  // project: all of them run on Node.
  ...defineConfig({
    files: ['*.config.{ts,mjs}', '.husky/*.ts', 'tools/*.mjs'],
    extends: [modernNodeRecommended],
  }),
  // Files that no tsconfig includes get the default project of typed lint,
  // not a parse error. typescript-eslint refuses '**' here.
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.ts', '.husky/*.ts'],
        },
      },
    },
  },
];
`;

/** The Git hooks, each in TypeScript. `.husky/<name>` is a link to `.husky/<name>.ts`. */
export const hooks: Record<string, string> = {
  '.husky/pre-commit.ts': `#!/usr/bin/env node
// .husky/pre-commit is a link to this file. Each step reads the staged commit
// and stages only what it wrote: Sync stages the files that nx sync updates,
// and Format refuses a staged file that is not formatted. The other steps
// refuse a Node or npm version written as a number, an .npmrc without the
// install policy, a package-lock.json that does not record each staged
// package.json, a lockfile that installs react, react-dom or zod twice, a
// package with an install script that allowScripts does not decide, a
// Dockerfile that installs without the lockfile, and a package.json that
// breaks the lint.
import {
  DependencyChecks,
  DockerfileInstallsFromLockfile,
  Format,
  InstallScriptsReviewed,
  LockfileSync,
  NoNumericPins,
  NpmrcPolicy,
  OneRuntimeCopy,
  Sync,
  preCommit,
} from '@zukhruf/git-hooks';

await preCommit([
  new Sync({ stage: ['**/tsconfig*.json', '**/styles.css'] }),
  new Format(),
  new NoNumericPins(),
  new NpmrcPolicy(),
  new LockfileSync(),
  new OneRuntimeCopy(),
  new InstallScriptsReviewed(),
  new DockerfileInstallsFromLockfile(),
  new DependencyChecks(),
]);
`,
  '.husky/pre-push.ts': `#!/usr/bin/env node
// .husky/pre-push is a link to this file. Build builds each pushed commit in
// its own snapshot, never the working tree. NODE_ENV is set because Vite sets
// production only when NODE_ENV is not set.
import { Build, prePush } from '@zukhruf/git-hooks';

await prePush([new Build({ env: { NODE_ENV: 'production' } })]);
`,
  '.husky/commit-msg.ts': `#!/usr/bin/env node
// .husky/commit-msg is a link to this file.
import { NxReleaseScope, commitMsg } from '@zukhruf/git-hooks';

await commitMsg([new NxReleaseScope()]);
`,
};

export const vscodeSettings = {
  'explorer.fileNesting.enabled': true,
  'explorer.fileNesting.expand': false,
  'explorer.fileNesting.patterns': {
    'tsconfig.base.json': '*.json',
    'tsconfig.json': '*.json, .gitignore',
  },
  'files.watcherExclude': {
    '**/node_modules/**': true,
    '**/.nx/**': true,
    '**/tmp/**': true,
    '**/.git/objects/**': true,
    '**/.git/subtree-cache/**': true,
  },
  'search.exclude': {
    '**/node_modules': true,
    '**/.nx': true,
    '**/tmp': true,
  },
};

export const vscodeExtensions = {
  recommendations: [
    'nrwl.angular-console',
    'esbenp.prettier-vscode',
    'dbaeumer.vscode-eslint',
  ],
};

export const agents = `# Agents

Nx monorepo on npm workspaces. Runnable products are in \`apps/\`, shared modules in \`packages/\`, and repo tools in \`tools/\`.

## Commands

- Run each command through an Nx target, from the workspace root: \`npx nx run <project>:<target>\`.
- \`npx nx run <project>:typecheck\` runs \`lint\`, \`format:check\`, then \`tsc\`. Never run raw \`tsc\`.
- \`npx nx run <project>:test\` builds the dependencies first.
- A check changes no file. \`npx nx run <project>:format\` writes the files.
- Read \`npx nx show project <project> --json\` before you say that a target exists. Most targets are inferred, so no file lists them.
- In zsh, quote a task name in a variable (\`"\${p}:lint"\`): \`:l\` and \`:t\` are modifiers.
- When Nx stops with an error that you do not expect, run it again with the output in a file: \`NX_DAEMON=false npx nx … > log 2>&1; echo $?\`.
`;

export const claude = '@AGENTS.md\n';

export function readme(name: string): string {
  return `# ${name}\n\nThe commands are in [AGENTS.md](./AGENTS.md).\n`;
}
