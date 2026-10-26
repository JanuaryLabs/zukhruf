import { type Concept, enable } from '../concept.ts';
import { SOURCE, TESTS, TEST_SUPPORT, TYPESCRIPT } from '../files.ts';
import noInternalAnchor from './no-internal-anchor.ts';
import noRawRoutePath from './no-raw-route-path.ts';
import { reactRouterOnlyThrowError } from './options.ts';
import requireLoaderDataTypeArgument from './require-loader-data-type-argument.ts';

const rules = {
  'require-loader-data-type-argument': requireLoaderDataTypeArgument,
  'no-raw-route-path': noRawRoutePath,
  'no-internal-anchor': noInternalAnchor,
};

export const reactRouter: Concept = {
  name: 'react-router',
  rules,
  config: (plugins) => [
    {
      name: 'zukhruf/react-router',
      files: SOURCE,
      plugins,
      rules: { 'zukhruf/require-loader-data-type-argument': 'error' },
    },
    {
      // A test renders links to whatever path it sets up.
      name: 'zukhruf/react-router/links',
      files: SOURCE,
      ignores: [...TESTS, ...TEST_SUPPORT],
      plugins,
      rules: enable({
        'no-raw-route-path': noRawRoutePath,
        'no-internal-anchor': noInternalAnchor,
      }),
    },
    {
      // `base` turns the rule on with no allow list. Loader helpers live
      // outside the route modules, so the allow list covers every file of
      // this config, not only a routes folder.
      name: 'zukhruf/react-router/throws',
      files: TYPESCRIPT,
      rules: {
        '@typescript-eslint/only-throw-error': [
          'error',
          reactRouterOnlyThrowError(),
        ],
      },
    },
  ],
};
