import { nxVersion, appPackageVersions as versions } from './versions.ts';

/**
 * The root packages of a React project, for react-app and ui-package. The 4
 * React lint plugins are the optional peers of @zukhruf/eslint that
 * `@zukhruf/eslint/react` loads, and each project config loads that. Vite 8 is
 * the peer of @rolldown/plugin-babel and @vitejs/plugin-react.
 */
export const reactRootPackages: Record<string, string> = {
  '@eslint-react/eslint-plugin': versions['@eslint-react/eslint-plugin'],
  '@rolldown/plugin-babel': versions['@rolldown/plugin-babel'],
  '@tailwindcss/vite': versions['@tailwindcss/vite'],
  '@types/react': versions['@types/react'],
  '@types/react-dom': versions['@types/react-dom'],
  '@vitejs/plugin-react': versions['@vitejs/plugin-react'],
  'babel-plugin-react-compiler': versions['babel-plugin-react-compiler'],
  'eslint-plugin-jsx-a11y-x': versions['eslint-plugin-jsx-a11y-x'],
  'eslint-plugin-react-hooks': versions['eslint-plugin-react-hooks'],
  'eslint-plugin-react-you-might-not-need-an-effect':
    versions['eslint-plugin-react-you-might-not-need-an-effect'],
  tailwindcss: versions.tailwindcss,
  vite: versions.vite,
};

/**
 * Packages that @nx/react and @nx/js add to the root and no project loads.
 * The swc toolchain: Vite and esbuild bundle, and typescript-eslint parses.
 * eslint-plugin-import, eslint-plugin-jsx-a11y and eslint-plugin-react: the
 * `flat/react` config of @nx/react loads them, `@zukhruf/eslint/react` loads
 * none of them, and each caps its ESLint peer below ESLint 10.
 * eslint-plugin-react-hooks stays: `@zukhruf/eslint/react` loads it. React
 * itself: each project declares the React that it imports.
 */
export const reactResidue = [
  'react',
  'react-dom',
  '@swc/cli',
  '@swc/core',
  '@swc/helpers',
  'eslint-plugin-import',
  'eslint-plugin-jsx-a11y',
  'eslint-plugin-react',
];

/**
 * @juristr/nx-tailwind-sync depends on @nx/devkit 21.1.2, whose peer would
 * install a second `nx`. The edge goes to the one Nx version (#4532).
 */
export const tailwindSyncOverrides = {
  '@juristr/nx-tailwind-sync': { '@nx/devkit': nxVersion },
};

/** The ESLint config of a React project: `@zukhruf/eslint/react`, the root config and `extra`. */
export function reactEslintConfig(
  rootOffset: string,
  extra: readonly string[],
): string {
  const zukhrufImport =
    extra.length > 0 ? "import zukhruf from '@zukhruf/eslint';\n" : '';
  const configs = extra
    .map((name) => `  ...zukhruf.configs['${name}'],\n`)
    .join('');
  return `${zukhrufImport}import react from '@zukhruf/eslint/react';

import baseConfig from '${rootOffset}eslint.config.mjs';

export default [
  ...react,
  ...baseConfig,
${configs}];
`;
}
