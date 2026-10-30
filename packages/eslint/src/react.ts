import nx from '@nx/eslint-plugin';

// @nx/eslint-plugin (checked 24.0.2) requires eslint-plugin-import,
// eslint-plugin-jsx-a11y, eslint-plugin-react and eslint-plugin-react-hooks in
// flat/react, but declares none of them. This package declares them as optional
// peers, so npm writes the lockfile edges that Nx hashes for a lint input on
// @zukhruf/eslint. Delete the peers when @nx/eslint-plugin declares them.
export default nx.configs['flat/react'];
