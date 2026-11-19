import assert from 'node:assert/strict';
import { test } from 'node:test';

import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { testUtils, twoFactor } from 'better-auth/plugins';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import {
  TwoFactorRequiredError,
  UnauthenticatedError,
  requireSession,
} from './hono.ts';

// A real better-auth instance on its own memory database. testUtils is
// better-auth's own test plugin: it saves a user and signs them in, and gives
// the cookie headers of that session. Saving a user with twoFactorEnabled is
// platform setup that no operation gives without a TOTP code; the real
// sign-in of a two-factor user is the test of its own below.
function authWithTwoFactor() {
  return betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'a-test-secret-that-is-long-enough-for-better-auth',
    database: memoryAdapter({}),
    emailAndPassword: { enabled: true },
    plugins: [twoFactor(), testUtils()],
    logger: { disabled: true },
    telemetry: { enabled: false },
  });
}

function authWithoutTwoFactor() {
  return betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'a-test-secret-that-is-long-enough-for-better-auth',
    database: memoryAdapter({}),
    emailAndPassword: { enabled: true },
    plugins: [testUtils()],
    logger: { disabled: true },
    telemetry: { enabled: false },
  });
}

// What a browser sends back: the name=value of each Set-Cookie.
function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

// The error branch of an @zukhruf/nx:node-app backend, which answers every
// HTTPException with its message, cause and status.
function answer(app: Hono) {
  app.onError((error, c) => {
    if (error instanceof HTTPException)
      return c.json(
        {
          error: error.message,
          cause: error.cause,
          unauthenticated: error instanceof UnauthenticatedError,
          twoFactorRequired: error instanceof TwoFactorRequiredError,
        },
        error.status,
      );
    return c.json({ error: 'Internal Server Error' }, 500);
  });
  return app;
}

test('a request without a session is refused with 401 and auth/unauthenticated, and the handler never runs', async () => {
  // Arrange
  const auth = authWithoutTwoFactor();
  let ran = false;
  const app = answer(new Hono());
  app.get('/api/me', requireSession(auth), (c) => {
    ran = true;
    return c.json(c.var.session.user);
  });

  // Act
  const response = await app.request('/api/me');

  // Assert
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: 'Authentication required',
    cause: {
      code: 'auth/unauthenticated',
      detail: 'The request has no session',
    },
    unauthenticated: true,
    twoFactorRequired: false,
  });
  assert.equal(ran, false);
});

test('a cookie that names no session is refused with 401', async () => {
  // Arrange
  const auth = authWithoutTwoFactor();
  const app = answer(new Hono());
  app.get('/api/me', requireSession(auth), (c) => c.json(c.var.session.user));

  // Act
  const response = await app.request('/api/me', {
    headers: { cookie: 'better-auth.session_token=forged.signature' },
  });

  // Assert
  assert.equal(response.status, 401);
});

test('a signed-in request reaches the handler, which reads the user and the session row from c.var.session', async () => {
  // Arrange
  const auth = authWithoutTwoFactor();
  const { test: helpers } = await auth.$context;
  const user = await helpers.saveUser(
    helpers.createUser({ email: 'reader@example.com', name: 'Reader' }),
  );
  const { headers, session } = await helpers.login({ userId: user.id });
  const app = answer(new Hono());
  app.get('/api/me', requireSession(auth), (c) =>
    c.json({
      email: c.var.session.user.email,
      sessionId: c.var.session.session.id,
    }),
  );

  // Act
  const response = await app.request('/api/me', { headers });

  // Assert
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    email: 'reader@example.com',
    sessionId: session.id,
  });
});

test('app.use guards every route under its path, and the chained route sees the session', async () => {
  // Arrange
  const auth = authWithoutTwoFactor();
  const { test: helpers } = await auth.$context;
  const user = await helpers.saveUser(
    helpers.createUser({ email: 'chain@example.com' }),
  );
  const { headers } = await helpers.login({ userId: user.id });
  const app = answer(new Hono());
  app
    .use('/api/*', requireSession(auth))
    .get('/api/me', (c) => c.json({ id: c.var.session.user.id }));

  // Act
  const guest = await app.request('/api/me');
  const member = await app.request('/api/me', { headers });

  // Assert
  assert.equal(guest.status, 401);
  assert.deepEqual(await member.json(), { id: user.id });
});

test('twoFactor refuses a signed-in user who never turned two-factor on with 403 and auth/two-factor-required', async () => {
  // Arrange
  const auth = authWithTwoFactor();
  const { test: helpers } = await auth.$context;
  const user = await helpers.saveUser(
    helpers.createUser({
      email: 'no-2fa@example.com',
      twoFactorEnabled: false,
    }),
  );
  const { headers } = await helpers.login({ userId: user.id });
  let ran = false;
  const app = answer(new Hono());
  app.get('/api/me', requireSession(auth, { twoFactor: true }), (c) => {
    ran = true;
    return c.json(c.var.session.user);
  });

  // Act
  const response = await app.request('/api/me', { headers });

  // Assert
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: 'Two-factor authentication required',
    cause: {
      code: 'auth/two-factor-required',
      detail: 'The user has not turned on two-factor authentication',
    },
    unauthenticated: false,
    twoFactorRequired: true,
  });
  assert.equal(ran, false);
});

test('twoFactor refuses a request without a session with 401, not 403', async () => {
  // Arrange
  const auth = authWithTwoFactor();
  const app = answer(new Hono());
  app.get('/api/me', requireSession(auth, { twoFactor: true }), (c) =>
    c.json(c.var.session.user),
  );

  // Act
  const response = await app.request('/api/me');

  // Assert
  assert.equal(response.status, 401);
});

test('twoFactor lets a user with two-factor turned on through, and the handler reads twoFactorEnabled', async () => {
  // Arrange: testUtils signs in without the code, as better-auth does once
  // the code was entered.
  const auth = authWithTwoFactor();
  const { test: helpers } = await auth.$context;
  const user = await helpers.saveUser(
    helpers.createUser({
      email: 'with-2fa@example.com',
      twoFactorEnabled: true,
    }),
  );
  const { headers } = await helpers.login({ userId: user.id });
  const app = answer(new Hono());
  app.get('/api/me', requireSession(auth, { twoFactor: true }), (c) =>
    c.json({ twoFactorEnabled: c.var.session.user.twoFactorEnabled }),
  );

  // Act
  const response = await app.request('/api/me', { headers });

  // Assert
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { twoFactorEnabled: true });
});

test('without twoFactor, a user who never turned two-factor on passes', async () => {
  // Arrange
  const auth = authWithTwoFactor();
  const { test: helpers } = await auth.$context;
  const user = await helpers.saveUser(
    helpers.createUser({ email: 'plain@example.com', twoFactorEnabled: false }),
  );
  const { headers } = await helpers.login({ userId: user.id });
  const app = answer(new Hono());
  app.get('/api/me', requireSession(auth), (c) =>
    c.json({ id: c.var.session.user.id }),
  );

  // Act
  const response = await app.request('/api/me', { headers });

  // Assert
  assert.equal(response.status, 200);
});

test('an error of getSession reaches the app as it is, not as a refusal', async () => {
  // Arrange: a session source whose database is down.
  const down = new Error('connect ECONNREFUSED');
  const source = {
    api: {
      getSession: (): Promise<{ user: { id: string } } | null> =>
        Promise.reject(down),
    },
  };
  let seen: unknown;
  const app = new Hono();
  app.onError((error, c) => {
    seen = error;
    return c.text('down', 500);
  });
  app.get('/api/me', requireSession(source), (c) => c.text('ok'));

  // Act
  const response = await app.request('/api/me');

  // Assert
  assert.equal(response.status, 500);
  assert.equal(seen, down);
});

test('the types: a betterAuth instance is a session source, twoFactor needs the two-factor plugin, and the session is the app’s own', () => {
  const withPlugin = authWithTwoFactor();
  const withoutPlugin = authWithoutTwoFactor();

  requireSession(withPlugin, { twoFactor: true });
  requireSession(withoutPlugin);
  // @ts-expect-error an app without the two-factor plugin cannot ask for it
  requireSession(withoutPlugin, { twoFactor: true });

  new Hono().get('/', requireSession(withPlugin), (c) => {
    const enabled: boolean | null | undefined =
      c.var.session.user.twoFactorEnabled;
    const token: string = c.var.session.session.token;
    // @ts-expect-error the session is not null behind requireSession
    const nullable: null = c.var.session;
    return c.json({ enabled, token, nullable });
  });
});

test('twoFactor: false checks no second factor', async () => {
  // Arrange
  const auth = authWithTwoFactor();
  const { test: helpers } = await auth.$context;
  const user = await helpers.saveUser(
    helpers.createUser({ email: 'off@example.com', twoFactorEnabled: false }),
  );
  const { headers } = await helpers.login({ userId: user.id });
  const app = answer(new Hono());
  app.get('/api/me', requireSession(auth, { twoFactor: false }), (c) =>
    c.json({ id: c.var.session.user.id }),
  );

  // Act
  const response = await app.request('/api/me', { headers });

  // Assert
  assert.equal(response.status, 200);
});

test('a user who turned two-factor on and signed in with a password but no code yet is refused with 401', async () => {
  // Arrange: the real flow of better-auth's two-factor plugin.
  const auth = betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'a-test-secret-that-is-long-enough-for-better-auth',
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      twoFactor: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [twoFactor({ skipVerificationOnEnable: true })],
    logger: { disabled: true },
    telemetry: { enabled: false },
  });
  const credentials = {
    email: 'half@example.com',
    password: 'a-long-password',
  };
  const signUp = await auth.api.signUpEmail({
    body: { ...credentials, name: 'Half' },
    asResponse: true,
  });
  const signedUp = new Headers({
    cookie: cookiesOf(signUp),
  });
  await auth.api.enableTwoFactor({
    body: { password: credentials.password },
    headers: signedUp,
  });
  const signIn = await auth.api.signInEmail({
    body: credentials,
    asResponse: true,
  });
  const pending = new Headers({
    cookie: cookiesOf(signIn),
  });
  const app = answer(new Hono());
  app.get('/api/me', requireSession(auth, { twoFactor: true }), (c) =>
    c.json(c.var.session.user),
  );

  // Act
  const response = await app.request('/api/me', { headers: pending });

  // Assert
  assert.match(await signIn.text(), /"twoFactorRedirect":true/);
  assert.equal(response.status, 401);
});
