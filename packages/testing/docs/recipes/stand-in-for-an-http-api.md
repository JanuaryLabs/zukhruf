# Recipe: Stand in for an HTTP API with a local server

**Use case.** The code under test calls an HTTP API of another system: a model provider, an OpenTelemetry collector, the server of a generated SDK. A test that calls the real API needs the network and a key, and it cannot make the API fail on purpose. `HttpServer` starts a real HTTP server on `127.0.0.1` for one test. The test gives its origin to the code under test, answers each request with a Node.js request listener, and records what the code sent. Tests in sdk-it (`packages/command/src/lib/command.test.ts`), finetuning (`apps/finetuning/src/teacher.test.ts`) and text2sql (`apps/authx/backend/src/cors.integration.test.ts`) use it in this way.

**What you need.** Code under test that takes the origin of the API as an input, and `HttpServer` from `@zukhruf/testing/http`.

## The steps

1. Give the origin of the API to the code under test as a parameter. Do not set it in `process.env` ([ADR 0009](../adr/0009-a-test-never-changes-the-environment-of-its-process.md)).
2. In the test, acquire a server with `await using api = await http.start(handler)`. The acquisition resolves when the server listens.
3. In the handler, record the request, then answer it as the API does: a status, headers and a body.
4. Give `api.origin` to the code under test, then assert on its result and on the recorded requests.

## The program

The code under test reads an exchange rate from an API. One test answers with a rate and checks the request that the client sent. The other test answers `503` and checks that the client fails.

```ts title="rates.test.ts"
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';

// The code under test: a client of an exchange-rate API. It takes the origin
// of the API as an input, so a test can give it the origin of a stand-in.
async function rate(origin: string, from: string, to: string) {
  const response = await fetch(`${origin}/rates?from=${from}&to=${to}`, {
    headers: { authorization: 'Bearer test-key' },
  });
  if (!response.ok) throw new Error(`rates API answered ${response.status}`);
  const body = (await response.json()) as { rate: number };
  return body.rate;
}

const http = new HttpServer();

test('reads the rate from the API', async () => {
  const requests: { url?: string; authorization?: string }[] = [];
  await using api = await http.start((request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ rate: 1.08 }));
  });

  assert.equal(await rate(api.origin, 'EUR', 'USD'), 1.08);
  assert.deepEqual(requests, [
    { url: '/rates?from=EUR&to=USD', authorization: 'Bearer test-key' },
  ]);
  console.log(`stand-in at ${new URL(api.origin).hostname}, saw`, requests);
});

test('fails when the API is unavailable', async () => {
  await using api = await http.start((_request, response) => {
    response.writeHead(503).end();
  });

  await assert.rejects(rate(api.origin, 'EUR', 'USD'), {
    message: 'rates API answered 503',
  });
});
```

Output of `node --conditions=@zukhruf/source rates.test.ts` on Node.js 26.13.0 (the durations change from run to run):

```
stand-in at 127.0.0.1, saw [ { url: '/rates?from=EUR&to=USD', authorization: 'Bearer test-key' } ]
✔ reads the rate from the API (14.336625ms)
✔ fails when the API is unavailable (2.952125ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 19.332042
```

## Why it works

- `start` listens on port `0` of `127.0.0.1`, so the system gives each server a free port, and two tests that run at the same time get two servers. The origin holds that port (`src/http/http-server.ts`; `src/http/http-server.integration.test.ts`: "HTTP servers listen before acquisition resolves and dispose independently").
- The client sends a real request over a real socket. Thus the test checks the URL, the headers and the body that the code under test builds, and the code reads a real response with its status.
- `await using` disposes the handle when the test ends, also when an assertion fails. Disposal closes the active connections, also a response that is not finished, and waits until the server is closed ("HTTP disposal closes an unfinished response after scope failure").

## Things to know

- **The server listens only on the IPv4 loopback interface.** A client that resolves `localhost` to `::1` does not reach it. Give the client `api.origin`, which names `127.0.0.1` ("HTTP servers listen on the IPv4 loopback interface only").
- **The handler is a Node.js request listener.** To serve the fetch handler of a web framework, pass its bridge: `getRequestListener` of `@hono/node-server`, or `toNodeHandler` of `better-auth/node` ([ADR 0004](../adr/0004-a-servers-handler-is-a-node-request-listener.md)).
- **A handler that throws or rejects fails the test process.** The server sends no answer for it. A broken stand-in then does not look like a network error of the API ("a rejected async handler fails its process with its own error"; [ADR 0004](../adr/0004-a-servers-handler-is-a-node-request-listener.md)).
- **A handler that needs the origin reads a `const` that the test declares after the acquisition.** No request arrives before the test gives the origin to a client ([ADR 0004](../adr/0004-a-servers-handler-is-a-node-request-listener.md)).
- **Each test starts its own server.** A module that reads the origin from a global when it loads is not supported: a test never changes a global ([ADR 0005](../adr/0005-a-background-server-owns-its-connections.md), superseded by [ADR 0009](../adr/0009-a-test-never-changes-the-environment-of-its-process.md)).
- **When the code under test calls the API in the test process, an interception can also answer it.** An interception runs in the test process, fails each request that no handler answers, and records each request ([Intercepted requests](../../README.md#intercepted-requests), [ADR 0010](../adr/0010-the-msw-area-is-always-strict-and-records-each-request.md)). A server also answers a client in another process: the text2sql test gives the origin to a child process that it starts. See [HTTP servers and streams](../../README.md#http-servers-and-streams).
