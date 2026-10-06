import { importBanRule } from '../authoring/import-ban.ts';

export default importBanRule({
  description:
    'Disallow the legacy @deepagents/agent package; compose with @deepagents/context',
  packages: ['@deepagents/agent'],
  message:
    '@deepagents/agent is legacy. Build with @deepagents/context + the AI SDK directly.',
});
