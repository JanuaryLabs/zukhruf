import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { test } from 'node:test';

import spawn, { SubprocessError } from 'nano-spawn';

import { HttpServer } from './http-server.ts';

test('HTTP servers listen before acquisition resolves and dispose independently', async () => {
  const http = new HttpServer();
  await using first = await http.start((request, response) => {
    response.writeHead(201, { 'x-fixture': 'first' });
    response.end(request.url);
  });
  await using second = await http.start((_request, response) => {
    response.end('second');
  });
  assert(first.server instanceof Server);
  assert.equal(first.server.listening, true);
  assert.notEqual(first.origin, second.origin);
  assert.equal(new URL(first.origin).hostname, '127.0.0.1');

  const response = await fetch(`${first.origin}/example?value=1`);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-fixture'), 'first');
  assert.equal(await response.text(), '/example?value=1');

  const { cleanup } = first;
  await cleanup();
  await cleanup();
  assert.equal(first.server.listening, false);
  assert.equal(first.server.address(), null);
  await assert.rejects(fetch(first.origin));
  assert.equal(await (await fetch(second.origin)).text(), 'second');
});

test(
  'HTTP disposal closes an unfinished response after scope failure',
  { timeout: 2_000 },
  async () => {
    await using server = await new HttpServer().start((_request, response) => {
      response.writeHead(200);
      response.write('unfinished');
    });
    const response = await fetch(server.origin);
    const bodyClosed = assert.rejects(response.text());
    const failure = new Error('intentional scope failure');

    await assert.rejects(async () => {
      await using scoped = server;
      assert.equal(scoped.server.listening, true);
      throw failure;
    }, failure);

    await bodyClosed;
    assert.equal(server.server.listening, false);
    await assert.rejects(fetch(server.origin));
  },
);

test('HTTP acquisition preserves native bind errors without closing another server', async (t) => {
  const http = new HttpServer();
  await using occupied = await http.start((_request, response) => {
    response.end('occupied');
  });
  const port = Number(new URL(occupied.origin).port);
  const original = Server.prototype.listen;
  const listen = t.mock.method(
    Server.prototype,
    'listen',
    function (this: Server) {
      return Reflect.apply(original, this, [port, '127.0.0.1']);
    },
  );

  await assert.rejects(
    http.start((_request, response) => response.end()),
    {
      code: 'EADDRINUSE',
      address: '127.0.0.1',
      port,
    },
  );
  assert.equal(listen.mock.callCount(), 1);
  const failed = listen.mock.calls[0]?.this;
  assert(failed instanceof Server);
  assert.equal(failed.listening, false);
  assert.equal(failed.address(), null);
  assert.equal(await (await fetch(occupied.origin)).text(), 'occupied');
});

test(
  'a background server answers, and its process exits while connections to it stay open',
  { timeout: 15_000 },
  async () => {
    // The child keeps a served keep-alive connection, then opens an idle one.
    // A server holds either open for longer than the spawn timeout.
    const { stdout } = await spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import { once } from 'node:events';
          import { connect } from 'node:net';
          const { HttpServer } = await import(${JSON.stringify(new URL('./http-server.ts', import.meta.url).href)});
          const { origin } = await new HttpServer().background((request, response) => {
            response.end(request.url);
          });
          const body = await (await fetch(origin + '/answered')).text();
          const { hostname, port } = new URL(origin);
          const idle = connect(Number(port), hostname);
          await once(idle, 'connect');
          idle.unref();
          console.log(JSON.stringify({ origin, body }));
        `,
      ],
      { timeout: 10_000 },
    );

    const { origin, body } = JSON.parse(stdout);
    assert.equal(new URL(origin).hostname, '127.0.0.1');
    assert.equal(body, '/answered');
  },
);

test('an async handler answers', { timeout: 5_000 }, async () => {
  await using server = await new HttpServer().start(
    async (_request, response) => {
      await Promise.resolve();
      response.end('async');
    },
  );

  assert.equal(await (await fetch(server.origin)).text(), 'async');
});

test(
  'a rejected async handler fails its process with its own error',
  { timeout: 15_000 },
  async () => {
    // A server that answered or reset instead would hide a broken fake.
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          const { HttpServer } = await import(${JSON.stringify(new URL('./http-server.ts', import.meta.url).href)});
          await using server = await new HttpServer().start(async () => {
            throw new Error('the fake broke');
          });
          await fetch(server.origin);
        `,
      ],
      { timeout: 10_000 },
    );

    await assert.rejects(
      child,
      (error: unknown) =>
        error instanceof SubprocessError &&
        error.exitCode === 1 &&
        error.stderr.includes('Error: the fake broke'),
    );
  },
);

test('HTTP servers listen on the IPv4 loopback interface only', async () => {
  await using server = await new HttpServer().start((_request, response) => {
    response.end();
  });

  assert.deepEqual(server.server.address(), {
    address: '127.0.0.1',
    family: 'IPv4',
    port: Number(new URL(server.origin).port),
  });
});
