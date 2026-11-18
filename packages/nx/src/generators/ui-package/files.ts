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

export function packageNameComponent(importPath: string): string {
  return `export const packageName = '${importPath}';

export function PackageName() {
  return <span>{packageName}</span>;
}
`;
}

// React DOM checks for a DOM when it loads, so the test loads it after it
// registers the DOM. Node cannot load .tsx, so the component comes from the
// built package.
export function componentTest(importPath: string): string {
  return `import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GlobalRegistrator } from '@happy-dom/global-registrator';

test('PackageName renders the name of the package', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { PackageName } = await import('${importPath}');
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    try {
      // Act
      await act(async () => {
        root.render(createElement(PackageName));
      });

      // Assert
      assert.equal(container.textContent, '${importPath}');
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});
`;
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
