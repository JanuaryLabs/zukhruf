import eslintReact from '@eslint-react/eslint-plugin';
import jsxA11y from 'eslint-plugin-jsx-a11y-x';
import reactHooks from 'eslint-plugin-react-hooks';

import { TYPESCRIPT } from './files.ts';

// react is an optional peer, because its version changes the lint result:
// @eslint-react/shared 5.28.8 (dist/index.js:184, :190-195) reads the version
// of the react that resolves from the folder where ESLint runs. With the peer,
// npm writes the lockfile edge, so @zukhruf/nx/lint hashes the React version
// in a lint input on @zukhruf/eslint.

// The community configs set no `files`. @eslint-react's type-checked rules need the
// parser services that zukhruf/base/typed gives to TYPESCRIPT only, and they
// throw on any other file, for example a package.json under
// jsonc-eslint-parser.
export default [
  jsxA11y.configs.recommended,
  reactHooks.configs.flat.recommended,
  eslintReact.configs['recommended-type-checked'],
  eslintReact.configs['disable-conflict-eslint-plugin-react-hooks'],
].map((config) => ({ ...config, files: TYPESCRIPT }));
