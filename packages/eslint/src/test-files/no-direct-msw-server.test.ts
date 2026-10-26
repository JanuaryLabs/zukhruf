import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-direct-msw-server.ts';

test('no-direct-msw-server', () => {
  typescriptRuleTester().run('no-direct-msw-server', rule, {
    valid: [
      {
        code: `import { Msw } from '@zukhruf/testing/msw';\nawait using msw = new Msw().intercept(...handlers);`,
      },
      // A setupServer that msw/node did not export is something else.
      { code: `import { setupServer } from './server.ts';\nsetupServer();` },
      { code: `setupServer();` },
      // Another export of msw/node.
      {
        code: `import { setupServer, SetupServerApi } from 'msw/node';\nSetupServerApi();`,
      },
      // Passing the function on is not a call.
      {
        code: `import { setupServer } from 'msw/node';\nregister(setupServer);`,
      },
      { code: `import * as node from 'msw/node';\nnode.other();` },
      // A type import is not a server.
      {
        code: `import type { SetupServerApi } from 'msw/node';\nlet server: SetupServerApi;`,
      },
    ],
    invalid: [
      `import { setupServer } from 'msw/node';\nconst server = setupServer();`,
      `import { setupServer as setup } from 'msw/node';\nconst server = setup(...handlers);`,
      `import * as node from 'msw/node';\nconst server = node.setupServer();`,
    ].map((code) => ({ code, errors: [{ messageId: 'direct' }] })),
  });
});
