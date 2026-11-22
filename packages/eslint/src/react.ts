import eslintReact from '@eslint-react/eslint-plugin';
import jsxA11y from 'eslint-plugin-jsx-a11y-x';
import reactHooks from 'eslint-plugin-react-hooks';
import youMightNotNeedAnEffect from 'eslint-plugin-react-you-might-not-need-an-effect';

import { TYPESCRIPT } from './files.ts';

// react is an optional peer, because its version changes the lint result:
// @eslint-react/shared 5.28.8 (dist/index.js:184, :190-195) reads the version
// of the react that resolves from the folder where ESLint runs. With the peer,
// npm writes the lockfile edge, so @zukhruf/nx/lint hashes the React version
// in a lint input on @zukhruf/eslint.

// The @zukhruf/shadcn components that a wrapping `<label>` labels. Most render a
// labelable element (`<input>`, `<textarea>`, `<select>` or `<button>`). Base UI's
// Checkbox, Switch and Radio render a `<span>` and take their name from a parent
// `<label>` (@base-ui/react internals/labelable-provider/useAriaLabelledBy.js).
// With this list, `label-has-associated-control` finds the control in
// `<label>Name <Input /></label>` and does not read a childless `<Checkbox />`
// as the label's text.
// It lives here, not in the shadcn concept, because that concept's hosts may not
// load the jsx-a11y-x plugin.
const KIT_CONTROLS = [
  'Checkbox',
  'ComboboxChipsInput',
  'ComboboxInput',
  'Input',
  'InputGroupInput',
  'InputGroupTextarea',
  'InputOTP',
  'NativeSelect',
  'RadioGroupItem',
  'SelectTrigger',
  'SidebarInput',
  'Slider',
  'Switch',
  'Textarea',
];

// The community configs set no `files`. @eslint-react's type-checked rules need the
// parser services that zukhruf/base/typed gives to TYPESCRIPT only, and they
// throw on any other file, for example a package.json under
// jsonc-eslint-parser.
export default [
  jsxA11y.configs.recommended,
  {
    rules: {
      // Severity and `assert` match `recommended`. `depth` 4 reaches the text of
      // shadcn's choice card (label > Field > FieldContent > FieldTitle > text),
      // which the default 2 misses once the Checkbox in it no longer counts as text.
      'jsx-a11y-x/label-has-associated-control': [
        'error',
        { controlComponents: KIT_CONTROLS, assert: 'either', depth: 4 },
      ],
    },
  },
  reactHooks.configs.flat.recommended,
  eslintReact.configs['recommended-type-checked'],
  eslintReact.configs['disable-conflict-eslint-plugin-react-hooks'],
  youMightNotNeedAnEffect.configs.strict,
].map((config) => ({ ...config, files: TYPESCRIPT }));
