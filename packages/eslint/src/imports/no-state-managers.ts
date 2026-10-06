import { importBanRule } from '../authoring/import-ban.ts';

export default importBanRule({
  description: 'Disallow external state managers',
  packages: [
    'zustand',
    'jotai',
    'redux',
    '@reduxjs/toolkit',
    'react-redux',
    'mobx',
    'mobx-react',
  ],
  message:
    'No external state managers. Use TanStack Query (server state), React Context (shared UI state), or URL state (shareable state).',
});
