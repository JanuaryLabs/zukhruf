import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { Server } from 'node:http';
import { test } from 'node:test';
import { promisify } from 'node:util';

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

test('HTTP disposal closes an unfinished response after scope failure', async () => {
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
});

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

test('an async handler answers', async () => {
  await using server = await new HttpServer().start(
    async (_request, response) => {
      await Promise.resolve();
      response.end('async');
    },
  );

  assert.equal(await (await fetch(server.origin)).text(), 'async');
});

test('a rejected async handler fails its process with its own error', async () => {
  // A server that answered or reset instead would hide a broken fake.
  const child = promisify(execFile)(
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
      Error.isError(error) &&
      'code' in error &&
      error.code === 1 &&
      'stderr' in error &&
      String(error.stderr).includes('Error: the fake broke'),
  );
});

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

const nextTestKeepsItsFakeTimer = (requests: string) =>
  promisify(execFile)(process.execPath, [
    '--input-type=module',
    '--eval',
    `
    import assert from 'node:assert/strict';
    import { test } from 'node:test';
    import { setImmediate } from 'node:timers/promises';
    import { http, passthrough } from 'msw';
    import { HttpServer } from ${JSON.stringify(import.meta.resolve('./http-server.ts'))};
    import { Msw } from ${JSON.stringify(import.meta.resolve('../msw/msw.ts'))};

    setTimeout(() => {
      console.error('the child did not end in 20 s');
      process.exit(124);
    }, 20_000).unref();

    const turns = async () => {
      for (let turn = 0; turn < 5; turn += 1) {
        await setImmediate();
      }
    };

    test('a test that requests under fake timers', async (t) => {
      ${requests}
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

test('disposal waits until fetch has closed each connection that the server closed, so the next test keeps the timers that it fakes', async () => {
  await nextTestKeepsItsFakeTimer(`
    await using server = await new HttpServer().start((_request, response) => {
      response.end('ok');
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(await (await fetch(server.origin)).text(), 'ok');
  `);
});

test('behind an msw passthrough, disposal settles after fetch has closed each connection that the server closed, so the next test keeps the timers that it fakes', async () => {
  await nextTestKeepsItsFakeTimer(`
    await using server = await new HttpServer().start((_request, response) => {
      response.end('ok');
    });
    await using _interception = new Msw().intercept(
      http.all(\`\${server.origin}/*\`, () => passthrough()),
    );
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(await (await fetch(server.origin)).text(), 'ok');
    assert.equal(await (await fetch(server.origin)).text(), 'ok');
  `);
});

test('disposal settles while a client in another process holds its connection open', async () => {
  await using server = await new HttpServer().start((_request, response) => {
    response.end('ok');
  });
  const client = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    `
    setTimeout(() => {
      console.error('the client did not end in 20 s');
      process.exit(124);
    }, 20_000);
    await (await fetch(${JSON.stringify(server.origin)})).text();
    console.log('connected');
    `,
  ]);
  try {
    await once(client.stdout, 'data');
    const connections = await promisify(
      server.server.getConnections.bind(server.server),
    )();
    assert.equal(connections, 1);

    const first = await Promise.race([
      server[Symbol.asyncDispose]().then(() => 'the disposal settled'),
      once(client, 'exit').then(() => 'the client exited'),
    ]);

    assert.equal(first, 'the disposal settled');
  } finally {
    client.kill();
  }
});
