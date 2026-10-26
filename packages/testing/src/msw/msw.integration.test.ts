import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpResponse, http, passthrough } from 'msw';

import { HttpServer } from '../http/http-server.ts';
import { Msw } from './msw.ts';

const bypassRejected = (error: unknown) =>
  error instanceof TypeError &&
  error.cause instanceof Error &&
  error.cause.message.includes(
    'Cannot bypass a request when using the "error" strategy',
  );

test('a request that no handler answers rejects with the msw error', async () => {
  using _interception = new Msw().intercept(
    http.get('https://api.example.invalid/user', () =>
      HttpResponse.json({ id: 1 }),
    ),
  );

  await assert.rejects(
    fetch('https://api.example.invalid/unknown'),
    bypassRejected,
  );
});

test('a passthrough handler for the origin of a local server sends its requests there, and a request to another host still rejects', async () => {
  await using local = await new HttpServer().start((request, response) => {
    response.end(`local ${request.method} ${request.url}`);
  });
  using _interception = new Msw().intercept(
    http.all(`${local.origin}/*`, () => passthrough()),
    http.get('https://api.example.invalid/user', () =>
      HttpResponse.json({ id: 1 }),
    ),
  );

  const response = await fetch(`${local.origin}/health`);

  assert.equal(await response.text(), 'local GET /health');
  await assert.rejects(
    fetch('https://other.example.invalid/unknown'),
    bypassRejected,
  );
});

test('requests holds a clone of each request in the order of arrival, with a body to read after the handler read it', async () => {
  const bodies: string[] = [];
  using interception = new Msw().intercept(
    http.post('https://api.example.invalid/events', async ({ request }) => {
      bodies.push(await request.text());
      return new HttpResponse(null, { status: 204 });
    }),
    http.get('https://api.example.invalid/user', () =>
      HttpResponse.json({ id: 1 }),
    ),
  );

  await fetch('https://api.example.invalid/events', {
    method: 'POST',
    body: 'first',
  });
  await fetch('https://api.example.invalid/user', {
    headers: { authorization: 'Bearer token' },
  });
  await fetch('https://api.example.invalid/events', {
    method: 'POST',
    body: 'second',
  });

  assert.deepEqual(bodies, ['first', 'second']);
  assert.deepEqual(
    interception.requests.map(({ method, url }) => `${method} ${url}`),
    [
      'POST https://api.example.invalid/events',
      'GET https://api.example.invalid/user',
      'POST https://api.example.invalid/events',
    ],
  );
  assert.deepEqual(
    await Promise.all(interception.requests.map((request) => request.text())),
    ['first', '', 'second'],
  );
  assert.equal(
    interception.requests.at(1)?.headers.get('authorization'),
    'Bearer token',
  );
});

test('server.use adds a handler for a part of the test', async () => {
  using interception = new Msw().intercept();
  await assert.rejects(
    fetch('https://api.example.invalid/user'),
    bypassRejected,
  );

  interception.server.use(
    http.get('https://api.example.invalid/user', () =>
      HttpResponse.json({ id: 2 }),
    ),
  );

  const response = await fetch('https://api.example.invalid/user');
  assert.deepEqual(await response.json(), { id: 2 });
});

test('disposal closes the server, so requests reach the network again', async () => {
  await using local = await new HttpServer().start((_request, response) => {
    response.end('network');
  });
  const interception = new Msw().intercept(
    http.get(`${local.origin}/answer`, () => HttpResponse.text('intercepted')),
  );
  const intercepted = await fetch(`${local.origin}/answer`);
  assert.equal(await intercepted.text(), 'intercepted');

  interception.cleanup();

  const response = await fetch(`${local.origin}/answer`);
  assert.equal(await response.text(), 'network');
  assert.equal(interception.requests.length, 1);
});
