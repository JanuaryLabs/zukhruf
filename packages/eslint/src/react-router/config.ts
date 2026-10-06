import { type Concept, enable } from '../concept.ts';
import { SOURCE, TESTS } from '../files.ts';
import noInternalAnchor from './no-internal-anchor.ts';
import noRawRoutePath from './no-raw-route-path.ts';
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
      ignores: TESTS,
      plugins,
      rules: enable({
        'no-raw-route-path': noRawRoutePath,
        'no-internal-anchor': noInternalAnchor,
      }),
    },
  ],
};
