import { selectorRule } from '../authoring/selector-rule.ts';

// A `steps` list, of a job or of a composite action, that sets up Node with
// actions/setup-node and runs `npm ci` itself. esquery 1.7 matches nothing
// with a child chain inside `:has(> …)`, so each `:has` looks for a descendant
// pair; a pair named `uses` or `run` is a key of a step.
const SETUP_NODE = String.raw`YAMLPair[key.value='uses'][value.value=/^actions\/setup-node@/]`;
const NPM_CI = String.raw`YAMLPair[key.value='run'][value.value=/\bnpm ci\b/]`;

export default selectorRule({
  description:
    'Disallow a job that installs the workspace with actions/setup-node and `npm ci` instead of the setup-workspace action',
  selectors: [
    `YAMLPair[key.value='steps'] > YAMLSequence:has(${SETUP_NODE}):has(${NPM_CI})`,
  ],
  message:
    'Install the workspace with JanuaryLabs/zukhruf/.github/actions/setup-workspace@main, not actions/setup-node and `npm ci`: the npm that Node bundles is older than npm 12, ignores the allowScripts of package.json, and runs every install script.',
});
