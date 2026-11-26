import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type IncomingMessage, createServer } from 'node:http';

import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createAuthClient } from 'better-auth/client';
import { twoFactorClient } from 'better-auth/client/plugins';
import { toNodeHandler } from 'better-auth/node';
import { testUtils, twoFactor } from 'better-auth/plugins';

import { test } from '@zukhruf/parameterized-test';

import {
  AuthenticationUnavailableError,
  REDIRECT_TO,
  requireSession,
  safeRedirect,
} from './react-router.ts';

const APP = 'https://app.example';

// A real better-auth instance on its own memory database, answered in
// process: the client's fetch goes straight to auth.handler.
function authWithTwoFactor() {
  return betterAuth({
    baseURL: APP,
    secret: 'a-test-secret-that-is-long-enough-for-better-auth',
    database: memoryAdapter({}),
    emailAndPassword: { enabled: true },
    plugins: [twoFactor(), testUtils()],
    logger: { disabled: true },
    telemetry: { enabled: false },
  });
}

// The browser sends the session cookie with each request; here the client
// sends the cookie headers that testUtils gave, or none for a guest.
function clientOf(
  auth: ReturnType<typeof authWithTwoFactor>,
  cookies: Headers = new Headers(),
) {
  return createAuthClient({
    baseURL: APP,
    plugins: [twoFactorClient()],
    fetchOptions: {
      headers: cookies,
      customFetchImpl: (input, init) => auth.handler(new Request(input, init)),
    },
  });
}

async function signedIn(twoFactorEnabled: boolean) {
  const auth = authWithTwoFactor();
  const { test: helpers } = await auth.$context;
  const user = await helpers.saveUser(
    helpers.createUser({ email: 'visitor@example.com', twoFactorEnabled }),
  );
  const { headers } = await helpers.login({ userId: user.id });
  return { client: clientOf(auth, headers), user };
}

// What the loader threw: React Router's replace() is a Response with the
// target in Location and a header that marks it as a replace.
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (thrown) {
    return thrown;
  }
  assert.fail('the loader did not throw');
}

function redirectOf(thrown: unknown) {
  assert.ok(thrown instanceof Response, `threw ${String(thrown)}`);
  return {
    status: thrown.status,
    location: thrown.headers.get('Location'),
    replace: thrown.headers.get('X-Remix-Replace'),
  };
}

test('a guest on a page with a query is sent to sign in with the path and query as redirectTo, by replace', async () => {
  // Arrange
  const client = clientOf(authWithTwoFactor());
  const request = new Request(`${APP}/cases/42?tab=notes`);

  // Act
  const thrown = await thrownBy(
    requireSession(client, request, { signIn: '/sign-in' }),
  );

  // Assert
  assert.deepEqual(redirectOf(thrown), {
    status: 302,
    location: '/sign-in?redirectTo=%2Fcases%2F42%3Ftab%3Dnotes',
    replace: 'true',
  });
});

test('a signed-in visitor gets the session with the app’s own user fields', async () => {
  // Arrange
  const { client, user } = await signedIn(true);
  const request = new Request(`${APP}/cases/42`);

  // Act
  const session = await requireSession(client, request, {
    signIn: '/sign-in',
    twoFactorSetup: '/two-factor/setup',
  });

  // Assert
  assert.equal(session.user.id, user.id);
  assert.equal(session.user.twoFactorEnabled, true);
});

test('a user who never turned two-factor on is sent to twoFactorSetup with the return path', async () => {
  // Arrange
  const { client } = await signedIn(false);
  const request = new Request(`${APP}/cases/42?tab=notes`);

  // Act
  const thrown = await thrownBy(
    requireSession(client, request, {
      signIn: '/sign-in',
      twoFactorSetup: '/two-factor/setup',
    }),
  );

  // Assert
  assert.deepEqual(redirectOf(thrown), {
    status: 302,
    location: '/two-factor/setup?redirectTo=%2Fcases%2F42%3Ftab%3Dnotes',
    replace: 'true',
  });
});

test('without twoFactorSetup, a user who never turned two-factor on gets the session', async () => {
  // Arrange
  const { client, user } = await signedIn(false);

  // Act
  const session = await requireSession(client, new Request(`${APP}/cases`), {
    signIn: '/sign-in',
  });

  // Assert
  assert.equal(session.user.id, user.id);
});

test('the setup page itself lets a user without two-factor through, instead of redirecting to itself', async () => {
  // Arrange
  const { client, user } = await signedIn(false);
  const request = new Request(`${APP}/two-factor/setup?redirectTo=%2Fcases`);

  // Act
  const session = await requireSession(client, request, {
    signIn: '/sign-in',
    twoFactorSetup: '/two-factor/setup',
  });

  // Assert
  assert.equal(session.user.id, user.id);
});

test('a guest on the setup page is sent to sign in with the setup page’s own return path, not the setup page', async () => {
  // Arrange
  const client = clientOf(authWithTwoFactor());
  const request = new Request(
    `${APP}/two-factor/setup?redirectTo=${encodeURIComponent('/cases/42?tab=notes')}`,
  );

  // Act
  const thrown = await thrownBy(
    requireSession(client, request, {
      signIn: '/sign-in',
      twoFactorSetup: '/two-factor/setup',
    }),
  );

  // Assert
  assert.equal(
    redirectOf(thrown).location,
    '/sign-in?redirectTo=%2Fcases%2F42%3Ftab%3Dnotes',
  );
});

test('a guest on an auth page whose own return path is unsafe is sent to sign in with no return path', async () => {
  // Arrange
  const client = clientOf(authWithTwoFactor());
  const request = new Request(
    `${APP}/two-factor/setup?redirectTo=${encodeURIComponent('//evil.example')}`,
  );

  // Act
  const thrown = await thrownBy(
    requireSession(client, request, {
      signIn: '/sign-in',
      twoFactorSetup: '/two-factor/setup',
    }),
  );

  // Assert
  assert.equal(redirectOf(thrown).location, '/sign-in');
});

test('a return path longer than 2,048 characters is left out', async () => {
  // Arrange
  const client = clientOf(authWithTwoFactor());
  const request = new Request(`${APP}/search?q=${'a'.repeat(2048)}`);

  // Act
  const thrown = await thrownBy(
    requireSession(client, request, { signIn: '/sign-in' }),
  );

  // Assert
  assert.equal(redirectOf(thrown).location, '/sign-in');
});

test('an unreachable session endpoint throws AuthenticationUnavailableError with the network error as its cause, not a redirect', async () => {
  // Arrange: nothing listens on port 1.
  const client = createAuthClient({ baseURL: 'http://127.0.0.1:1' });

  // Act
  const thrown = await thrownBy(
    requireSession(client, new Request(`${APP}/cases`), { signIn: '/sign-in' }),
  );

  // Assert
  assert.ok(thrown instanceof AuthenticationUnavailableError);
  assert.ok(thrown.cause instanceof TypeError);
});

void test.each([500, 403], (status) =>
  test(`a session endpoint that answers ${status} throws AuthenticationUnavailableError with the error as its cause`, async () => {
    // Arrange: the server is up and answers with an error.
    const client = createAuthClient({
      baseURL: APP,
      fetchOptions: {
        customFetchImpl: () =>
          Promise.resolve(new Response('failed', { status })),
      },
    });

    // Act
    const thrown = await thrownBy(
      requireSession(client, new Request(`${APP}/cases`), {
        signIn: '/sign-in',
      }),
    );

    // Assert
    assert.ok(thrown instanceof AuthenticationUnavailableError);
    assert.deepEqual(thrown.cause, { status, statusText: '' });
  }),
);

// A real better-auth instance behind a real HTTP server, read with the real
// fetch, so an aborted signal cancels the read the way it does in a browser.
// `onRequest` sees each request before better-auth answers it.
async function servedAuth(onRequest: (request: IncomingMessage) => void) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  const baseURL = `http://127.0.0.1:${address.port}`;
  const handler = toNodeHandler(
    betterAuth({
      baseURL,
      secret: 'a-test-secret-that-is-long-enough-for-better-auth',
      database: memoryAdapter({}),
      logger: { disabled: true },
      telemetry: { enabled: false },
    }),
  );
  server.on('request', (request: IncomingMessage, response) => {
    onRequest(request);
    void handler(request, response);
  });
  return {
    client: createAuthClient({ baseURL }),
    baseURL,
    [Symbol.asyncDispose]: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

test('a request aborted before the session read rejects with the abort, not a redirect and not AuthenticationUnavailableError', async () => {
  // Arrange
  const reads: string[] = [];
  await using served = await servedAuth((request) => {
    reads.push(request.url ?? '');
  });
  const controller = new AbortController();
  controller.abort();

  // Act
  const thrown = await thrownBy(
    requireSession(
      served.client,
      new Request(`${served.baseURL}/cases`, { signal: controller.signal }),
      { signIn: '/sign-in' },
    ),
  );

  // Assert
  assert.equal(thrown, controller.signal.reason);
  assert.deepEqual(reads, []);
});

test('a request aborted while the session read is in flight rejects with the abort, not a redirect and not AuthenticationUnavailableError', async () => {
  // Arrange: the navigation leaves once better-auth has the read.
  const controller = new AbortController();
  await using served = await servedAuth(() => {
    controller.abort();
  });

  // Act
  const thrown = await thrownBy(
    requireSession(
      served.client,
      new Request(`${served.baseURL}/cases`, { signal: controller.signal }),
      { signIn: '/sign-in' },
    ),
  );

  // Assert
  assert.equal(thrown, controller.signal.reason);
});

test('a guest on an auth page whose own return path names an auth page is sent to sign in with no return path', async () => {
  // Arrange
  const client = clientOf(authWithTwoFactor());
  const request = new Request(
    `${APP}/two-factor/setup?redirectTo=${encodeURIComponent('/sign-in')}`,
  );

  // Act
  const thrown = await thrownBy(
    requireSession(client, request, {
      signIn: '/sign-in',
      twoFactorSetup: '/two-factor/setup',
    }),
  );

  // Assert
  assert.equal(redirectOf(thrown).location, '/sign-in');
});

test('a guest on a sign-in page that already has a query keeps it, and the return path joins it', async () => {
  // Arrange
  const client = clientOf(authWithTwoFactor());

  // Act
  const thrown = await thrownBy(
    requireSession(client, new Request(`${APP}/cases`), {
      signIn: '/sign-in?method=password',
    }),
  );

  // Assert
  assert.equal(
    redirectOf(thrown).location,
    '/sign-in?method=password&redirectTo=%2Fcases',
  );
});

test('a guest on a path that starts with // is sent to sign in with no return path', async () => {
  // Arrange
  const client = clientOf(authWithTwoFactor());

  // Act
  const thrown = await thrownBy(
    requireSession(client, new Request(`${APP}//evil.example/x`), {
      signIn: '/sign-in',
    }),
  );

  // Assert
  assert.equal(redirectOf(thrown).location, '/sign-in');
});

test('the types: a better-auth client is a session client, twoFactorSetup needs the two-factor plugin, and a throwing client is refused', () => {
  const auth = authWithTwoFactor();
  const plain = createAuthClient({ baseURL: APP });
  const throwing = createAuthClient({
    baseURL: APP,
    fetchOptions: { throw: true },
  });
  const request = new Request(`${APP}/cases`);

  const guard = (): Promise<{
    user: { twoFactorEnabled: boolean | null | undefined };
  }> =>
    requireSession(clientOf(auth), request, {
      signIn: '/sign-in',
      twoFactorSetup: '/two-factor/setup',
    });
  const plainGuard = () =>
    requireSession(plain, request, {
      signIn: '/sign-in',
      // @ts-expect-error a client without the two-factor plugin cannot ask for it
      twoFactorSetup: '/two-factor/setup',
    });
  const throwingGuard = () =>
    requireSession(
      // @ts-expect-error a client made with throw: true gives no { data, error }
      throwing,
      request,
      { signIn: '/sign-in' },
    );
  assert.equal(typeof guard, 'function');
  assert.equal(typeof plainGuard, 'function');
  assert.equal(typeof throwingGuard, 'function');
});

// safeRedirect: the sign-in page's answer to its own redirectTo.
const origin = APP;
const fallback = '/home';
const exclude = ['/sign-in', '/two-factor/setup'];

void test.each(
  [
    [
      '/cases/42?tab=notes#n1',
      '/cases/42?tab=notes#n1',
      'a path with a query and a hash',
    ],
    ['/cases/../settings', '/settings', 'the parsed path, not the raw string'],
    [null, fallback, 'no redirectTo'],
    [undefined, fallback, 'no redirectTo'],
    ['', fallback, 'an empty value'],
    ['cases/42', fallback, 'a relative path'],
    ['https://evil.example/', fallback, 'an absolute URL'],
    [`${APP}/cases`, fallback, 'an absolute URL on the same origin'],
    ['//evil.example', fallback, 'a protocol-relative URL'],
    ['/\\evil.example', fallback, 'a backslash the browser reads as a slash'],
    ['/\t/evil.example', fallback, 'a tab the parser drops'],
    ['/\n/evil.example', fallback, 'a newline the parser drops'],
    ['/.//evil.example', fallback, 'a dot segment the parser folds into //'],
    ['javascript:alert(1)', fallback, 'a script URL'],
    ['/sign-in', fallback, 'an excluded page'],
    ['/sign-in?redirectTo=%2Fcases', fallback, 'an excluded page with a query'],
    ['/two-factor/setup', fallback, 'the other excluded page'],
    [
      `/${'a'.repeat(2047)}`,
      `/${'a'.repeat(2047)}`,
      'exactly 2,048 characters',
    ],
    [`/${'a'.repeat(2048)}`, fallback, 'over 2,048 characters'],
  ] as const,
  ([to, expected, why]) =>
    test(`safeRedirect(${JSON.stringify(to)?.slice(0, 40)}) gives ${expected.slice(0, 40)}: ${why}`, () => {
      // Act
      const target = safeRedirect(to, { origin, fallback, exclude });

      // Assert
      assert.equal(target, expected);
    }),
);

test('safeRedirect takes only the origin of a full URL given as origin', () => {
  // Act
  const target = safeRedirect('/cases', {
    origin: 'https://app.example/sign-in?x=1',
    fallback,
  });

  // Assert
  assert.equal(target, '/cases');
});

test('REDIRECT_TO is the query parameter that the guard writes', async () => {
  // Arrange
  const client = clientOf(authWithTwoFactor());

  // Act
  const thrown = await thrownBy(
    requireSession(client, new Request(`${APP}/cases`), { signIn: '/sign-in' }),
  );

  // Assert
  const location = new URL(redirectOf(thrown).location ?? '', APP);
  assert.equal(location.searchParams.get(REDIRECT_TO), '/cases');
});
