// The content of each file that ui-package writes. Each is a string in a .ts
// module, so tsc puts it in dist with no copy step (ADR 0009).

export function viteConfig(
  projectRoot: string,
  rootOffset: string,
  importPath: string,
): string {
  return `import path from 'node:path';

import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '${rootOffset}node_modules/.vite/${projectRoot}',
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(import.meta.dirname, 'tsconfig.lib.json'),
    }),
  ],
  assetsInclude: ['**/*.css'],
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    sourcemap: true,
    commonjsOptions: { transformMixedEsModules: true },
    lib: {
      entry: 'src/index.ts',
      name: '${importPath}',
      fileName: 'index',
      formats: ['es' as const],
    },
    rolldownOptions: {
      external: (id) =>
        id.startsWith('node:') ||
        !(
          id.startsWith('.') ||
          path.isAbsolute(id) ||
          id.startsWith('\\0') ||
          id.includes(':')
        ),
      output: { assetFileNames: 'assets/[name][extname]' },
    },
  },
}));
`;
}

export function rootTsconfig(rootOffset: string) {
  return {
    extends: `${rootOffset}tsconfig.base.json`,
    files: [],
    include: [],
    references: [
      { path: './tsconfig.lib.json' },
      { path: './tsconfig.spec.json' },
    ],
  };
}

export function libraryTsconfig(rootOffset: string) {
  return {
    extends: `${rootOffset}tsconfig.base.json`,
    compilerOptions: {
      lib: ['DOM', 'DOM.Iterable', 'DOM.AsyncIterable'],
      outDir: 'dist',
      types: [
        'node',
        '@nx/react/typings/cssmodule.d.ts',
        '@nx/react/typings/image.d.ts',
        'vite/client',
      ],
      rootDir: 'src',
      jsx: 'react-jsx',
      tsBuildInfoFile: 'dist/tsconfig.lib.tsbuildinfo',
    },
    exclude: [
      'out-tsc',
      'dist',
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/*.spec.tsx',
      '**/*.test.tsx',
      'eslint.config.js',
      'eslint.config.cjs',
      'eslint.config.mjs',
    ],
    include: ['src/**/*.js', 'src/**/*.jsx', 'src/**/*.ts', 'src/**/*.tsx'],
  };
}

export function specTsconfig(rootOffset: string) {
  return {
    extends: `${rootOffset}tsconfig.base.json`,
    compilerOptions: {
      rootDir: '.',
      outDir: 'out-tsc/spec',
      tsBuildInfoFile: 'out-tsc/spec/tsconfig.spec.tsbuildinfo',
      types: ['node', 'vite/client'],
    },
    include: ['vite.config.ts'],
    references: [{ path: './tsconfig.lib.json' }],
  };
}

export function publicApiTest(importPath: string): string {
  const packageName = importPath.split('/').at(-1);
  return `import assert from 'node:assert/strict';
import { test } from 'node:test';

import { packageName } from '${importPath}';

test('${packageName} is importable through its public package export', () => {
  assert.equal(packageName, '${importPath}');
});
`;
}
