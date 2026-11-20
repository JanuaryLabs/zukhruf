# Recipe: Intercept the requests of a child process

**Use case.** A test starts the app in a child process, and the app calls a real API. `new Msw().intercept(...)` starts an msw server only in the process that calls it ([Intercepted requests](../../README.md#intercepted-requests)). An interception in the test process does not see the requests of the child, so the child sends them to the network. A preload starts an msw server in the child, before the entry point of the app. Eight test files in the `context-compiler` and `offers-evals` repositories do this, such as `apps/ipay/src/ipay.test.ts` and `apps/startup-credits/src/startup-credits.test.ts` of `context-compiler`, and `apps/offers/src/offers.test.ts` of `offers-evals`.

**What you need.** `Msw` of `@zukhruf/testing/msw`, msw 3, and a temporary directory for the preload (`TemporaryFiles` of [`@zukhruf/fs`](../../../fs/README.md#make-a-temporary-directory)).

## The steps

1. Write the preload as a module string. It imports `Msw` and the msw handlers, and calls `new Msw().intercept(...handlers)`.
2. Resolve each import of the preload in the test with `import.meta.resolve`, and write the URL into the string.
3. Write the string to a file in a temporary directory.
4. Start the child with `--import <file>` before the entry point of the app.
5. Let the preload write each request to stderr, and read the stderr of the child in the test.

## The program

The program is the test and the app in one file. The test writes the preload and starts the program again as the app, with `--import`. The app sends one request that a handler answers and one request that no handler answers.

```ts title="intercept-a-child.ts"
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';

if (process.argv[2] === 'app') {
  // The app: it knows nothing of the test, and calls the real API.
  const user = await fetch('https://api.example.com/user', {
    headers: { authorization: 'Bearer token' },
  });
  console.log('user:', await user.text());
  try {
    await fetch('https://api.example.com/orders');
  } catch (error) {
    console.log('orders:', ((error as Error).cause as Error).message);
  }
} else {
  // The preload: a module that starts an msw server in the child, before
  // the app. The test resolves each import, because the preload is in a
  // temporary directory, where Node.js finds no node_modules.
  const preload = `
import { Msw } from ${JSON.stringify(import.meta.resolve('@zukhruf/testing/msw'))};
import { HttpResponse, http } from ${JSON.stringify(import.meta.resolve('msw'))};
const { server } = new Msw().intercept(
  http.get('https://api.example.com/user', () => HttpResponse.json({ id: 1 })),
);
server.events.on('request:start', ({ request }) => {
  process.stderr.write('request ' + request.method + ' ' + request.url + ' ' + request.headers.get('authorization') + '\\n');
});
`;
  await using folder = await new TemporaryFiles().directory('internet-');
  const setup = join(folder.path, 'internet.mjs');
  await writeFile(setup, preload);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    '--import',
    setup,
    import.meta.filename,
    'app',
  ]);
  console.log(`stdout of the child:\n${stdout}`);
  console.log(`stderr of the child:\n${stderr}`);
}
```

Output:

```
stdout of the child:
user: {"id":1}
orders: [MSW] Cannot bypass a request when using the "error" strategy for the "onUnhandledFrame" option.

stderr of the child:
request GET https://api.example.com/user Bearer token
request GET https://api.example.com/orders null
[MSW] Error: intercepted a request without a matching request handler:

  • GET https://api.example.com/orders

If you still wish to intercept this unhandled request, please create a request handler for it.
Read more: https://mswjs.io/docs/http/intercepting-requests

```

## What the output shows

- The child got `{"id":1}` from the handler of the preload. The app did not change: it sent its request to `https://api.example.com/user`.
- The request to `/orders` has no handler. The msw server of the preload is strict too: `fetch` rejected, and the cause is the msw error. msw wrote the method and the URL of the request to stderr.
- The preload wrote each request to stderr, with its `authorization` header. The test reads the requests there.

## Things to know

- **The test cannot read the `requests` of the msw server in the child.** That server and its handle are in the child process. Let the preload write what the test needs, to stderr or to a file that the test gives in the string, as `apps/offers/src/offers.test.ts` of `offers-evals` writes to a file.
- **Resolve the imports in the test.** Node.js resolves a package from the parent directories of the file that imports it. The temporary directory has no `node_modules`, so a bare `'msw'` in the preload fails. `import.meta.resolve` gives the URL of the file that the test itself loads. The other way is a parent in the repository for the temporary directory ([`@zukhruf/fs`](../../../fs/README.md#make-a-temporary-directory)).
- **Give the data of the test to the preload with `JSON.stringify`.** The preload is a string, so a handler can use only values that the test writes into it. A function of the test does not go into the child.
- **One `--import` flag for each preload.** To also make a package look not installed in the child, give `notInstalled(...)` with its own `--import` flag ([Preloads](../../README.md#preloads)).
- **With the `@zukhruf/source` condition, the child loads the source of the package.** `import.meta.resolve('@zukhruf/testing/msw')` gives `src/msw/msw.ts`, which Node.js runs with its type stripping. Without the condition, it gives the built `dist/msw/msw.js`.
