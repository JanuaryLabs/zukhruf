import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import { test } from 'node:test';
import * as tls from 'node:tls';

import { HttpResponse, http, passthrough } from 'msw';
import spawn from 'nano-spawn';

import { HttpServer } from '../http/http-server.ts';
import { Msw } from './msw.ts';

const bypassRejected = (error: unknown) =>
  error instanceof TypeError &&
  Error.isError(error.cause) &&
  error.cause.message.includes(
    'Cannot bypass a request when using the "error" strategy',
  );

test('a request that no handler answers rejects with the msw error', async () => {
  await using interception = new Msw().intercept(
    http.get('https://api.example.invalid/user', () =>
      HttpResponse.json({ id: 1 }),
    ),
  );

  await assert.rejects(
    fetch('https://api.example.invalid/unknown'),
    bypassRejected,
  );

  assert.deepEqual(
    interception.requests.map(({ url }) => url),
    ['https://api.example.invalid/unknown'],
  );
});

test('a passthrough handler for the origin of a local server sends its requests there, and a request to another host still rejects', async () => {
  await using local = await new HttpServer().start((request, response) => {
    response.end(`local ${request.method} ${request.url}`);
  });
  await using _interception = new Msw().intercept(
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
  await using interception = new Msw().intercept(
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
  await using interception = new Msw().intercept();
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
  await using interception = new Msw().intercept(
    http.get(`${local.origin}/answer`, () => HttpResponse.text('intercepted')),
  );
  const intercepted = await fetch(`${local.origin}/answer`);
  assert.equal(await intercepted.text(), 'intercepted');

  await interception.cleanup();

  const response = await fetch(`${local.origin}/answer`);
  assert.equal(await response.text(), 'network');
  assert.equal(interception.requests.length, 1);
});

test('disposal waits until fetch has closed each connection that the server closed, so the next test keeps the timers that it fakes', async () => {
  const msw = import.meta.resolve('./msw.ts');

  await spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    `
    import assert from 'node:assert/strict';
    import { test } from 'node:test';
    import { setImmediate } from 'node:timers/promises';
    import { HttpResponse, http } from 'msw';
    import { Msw } from ${JSON.stringify(msw)};

    const turns = async () => {
      for (let turn = 0; turn < 5; turn += 1) {
        await setImmediate();
      }
    };

    test('a test that fetches under fake timers', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      await using _interception = new Msw().intercept(
        http.get('https://api.example.invalid/user', () => HttpResponse.json({ id: 1 })),
      );
      await (await fetch('https://api.example.invalid/user')).json();
      t.mock.timers.tick(1_000);
      await turns();
    });

    test('the next test fires its own fake timer', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let fired = false;
      setTimeout(() => {
        fired = true;
      }, 1);
      await turns();
      t.mock.timers.tick(1);
      assert.equal(fired, true);
    });
    `,
  ]);
});

test('disposal settles after a TCP connection that passed through the interceptor and that the client closed', async () => {
  await using echo = createServer((socket) => socket.pipe(socket));
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const address = echo.address();
  assert.ok(address !== null && typeof address === 'object');
  const { port } = address;

  {
    await using _interception = new Msw().intercept();
    const client = connect(port, '127.0.0.1');
    await once(client, 'connect');
    client.write('ping');
    const [echoed] = await once(client, 'data');
    assert.equal(String(echoed), 'ping');
    client.end();
    await once(client, 'close');
  }
});

// A self-signed certificate for 127.0.0.1, valid until 2126, made with
// `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes
// -days 36500 -subj /CN=localhost -addext subjectAltName=IP:127.0.0.1`.
// Node has no API that makes a certificate.
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgy6C+Rla1gqmpcT3H
VI8DxW8tDWJ8u3i0rxhytjXgFxahRANCAARZUdfXsGy4a1K7rLkaPvYrXn7Gjsbz
YgXWwzvXgn7K8Vpfg2jImJRLPXigMI212e3ebuYcVgioI7PWu9VAE3AO
-----END PRIVATE KEY-----
`;
const cert = `-----BEGIN CERTIFICATE-----
MIIBbzCCARWgAwIBAgIUeDCPsTL/oZISO4iQ9s1boYB95pIwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEyNDA5NTcyOFoYDzIxMjYxMDMx
MDk1NzI4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARZUdfXsGy4a1K7rLkaPvYrXn7GjsbzYgXWwzvXgn7K8Vpfg2jImJRL
PXigMI212e3ebuYcVgioI7PWu9VAE3AOo0MwQTAdBgNVHQ4EFgQUHMWzXzEuOmlz
sO7V1BstKWQbxeowDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMAoG
CCqGSM49BAMCA0gAMEUCIApiritEi6dsQh6b1XammLNWbvCciZm+ziKjOenxTx9T
AiEAj3H5ASLjhiv/U35TDltyi0LA79aqMqh1S119aVVnVNU=
-----END CERTIFICATE-----
`;

test('disposal settles after a TLS connection that passed through the interceptor and that the client closed', async () => {
  await using echo = tls.createServer({ key, cert }, (socket) =>
    socket.pipe(socket),
  );
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  const address = echo.address();
  assert.ok(address !== null && typeof address === 'object');
  const { port } = address;

  {
    await using _interception = new Msw().intercept();
    const client = tls.connect({ port, host: '127.0.0.1', ca: cert });
    await once(client, 'secureConnect');
    client.write('ping');
    const [echoed] = await once(client, 'data');
    assert.equal(String(echoed), 'ping');
    client.end();
    await once(client, 'close');
  }
});
