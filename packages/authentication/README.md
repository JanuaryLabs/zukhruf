# @zukhruf/authentication

> Ezz accepted each ADR on 2026-11-19. Built and tested, not yet on npm.

An app that signs its users in with [better-auth](https://www.better-auth.com) asks the same two questions on every request: who sent it, and may it pass. This package answers both at the edges of the app. On the server, a Hono middleware reads the better-auth session from the request and refuses a request without one. In the browser, a React Router loader sends a visitor without a session to the sign-in page, and brings them back to the page they asked for, never to another site.

better-auth owns the sign-in itself: the methods, the cookies, the tables and the second factor. This package only reads what better-auth decided.

The words in these documents have one meaning each. See the glossary in [GLOSSARY.md](./GLOSSARY.md).

## Use it

```sh
npm install @zukhruf/authentication hono react-router
```

## Refuse a request without a session (Hono)

```ts
import { Hono } from 'hono';

import { requireSession } from '@zukhruf/authentication/hono';

import { auth } from './auth.ts';

// betterAuth({ … })

const app = new Hono();

app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// Everything under /api needs a session, and a user with two-factor turned on.
// Hono types c.var.session on the routes chained after use(), or on a route
// that lists the middleware itself.
app
  .use('/api/*', requireSession(auth, { twoFactor: true }))
  .get('/api/me', (c) => c.json(c.var.session.user)); // not null here
```

A route that a guest may read too calls `auth.api.getSession({ headers: c.req.raw.headers })` itself: better-auth already reads the session, so the package only requires one ([ADR 0002](./docs/adr/0002-the-package-only-requires-a-session-and-better-auths-getsession-reads-one.md)).

A request without a session gets `UnauthenticatedError` (401). A signed-in user without two-factor gets `TwoFactorRequiredError` (403). Both are `HTTPException`s, so the app's `onError` answers them as it answers every other `HTTPException` ([ADR 0004](./docs/adr/0004-a-refusal-is-an-httpexception-401-without-a-session-and-403-without-two-factor.md)).

## Send a visitor to sign in, and back (React Router)

```ts
import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import type { LoaderFunctionArgs } from 'react-router';

import {
  REDIRECT_TO,
  requireSession,
  safeRedirect,
} from '@zukhruf/authentication/react-router';

export const authClient = createAuthClient({ plugins: [twoFactorClient()] });

// The loader of every page behind sign-in.
export function protectedLoader({ request }: LoaderFunctionArgs) {
  return requireSession(authClient, request, {
    signIn: '/sign-in',
    twoFactorSetup: '/two-factor/setup',
  });
}

// The sign-in page, after a successful sign-in.
const target = safeRedirect(searchParams.get(REDIRECT_TO), {
  origin: location.origin,
  fallback: '/',
  exclude: ['/sign-in', '/two-factor/setup'],
});
navigate(target, { replace: true });
```

A visitor on `/cases/42?tab=notes` without a session lands on `/sign-in?redirectTo=%2Fcases%2F42%3Ftab%3Dnotes`. When better-auth cannot answer (the network or the server is down), the loader throws `AuthenticationUnavailableError` for the route's error element, instead of sending a signed-in user to sign in. A navigation away aborts the loader's request, and with it the session read ([ADR 0006](./docs/adr/0006-a-failed-session-read-is-authentication-unavailable-never-signed-out.md)).

## Errors

| Error                            | When                                                 | What the caller does next                          |
| -------------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `UnauthenticatedError` (401)     | no session                                           | sign in                                            |
| `TwoFactorRequiredError` (403)   | a session, but the user has not turned two-factor on | set up two-factor                                  |
| `AuthenticationUnavailableError` | the browser could not read the session               | try again later; the route's error element says so |

The two server errors carry `cause: { code, detail }`, the shape that the error handler of an `@zukhruf/nx:node-app` backend already answers with. An error of better-auth itself, or of the network on the server, reaches the caller as it is.

## The same concepts in other systems

| This package           | ASP.NET Core                                                                  | go-chi/jwtauth          | Remix indie-stack        | @hono/auth-js           |
| ---------------------- | ----------------------------------------------------------------------------- | ----------------------- | ------------------------ | ----------------------- |
| `requireSession(auth)` | `[Authorize]`, `RequireAuthorization()`                                       | `Authenticator(ja)`     | `requireUserId(request)` | `verifyAuth()`          |
| `{ twoFactor: true }`  | a policy with `RequireClaim("amr", "mfa")`; a failed policy is `Forbid` (403) | none                    | none                     | none                    |
| `UnauthenticatedError` | `Challenge` (401 or the login page)                                           | `http.Error(w, …, 401)` | `redirect('/login')`     | `HTTPException(401)`    |
| `REDIRECT_TO`          | `ReturnUrl`                                                                   | none                    | `redirectTo`             | `callbackUrl` (Auth.js) |
| `safeRedirect`         | `Url.IsLocalUrl`                                                              | none                    | `safeRedirect`           | none                    |

## API

```ts
// @zukhruf/authentication/hono
interface SessionSource<S> {
  api: { getSession(context: { headers: Headers }): Promise<S | null> };
} // the member of a better-auth instance that the package calls

type RequireSessionOptions<S extends { user: object }> =
  'twoFactorEnabled' extends keyof S['user']
    ? { readonly twoFactor?: boolean }
    : { readonly twoFactor?: never }; // `twoFactor` only with better-auth's two-factor plugin

function requireSession<S extends { user: object }>(
  auth: SessionSource<S>,
  options?: RequireSessionOptions<S>,
): MiddlewareHandler<{ Variables: { session: S } }>;

class UnauthenticatedError extends HTTPException {} // 401, cause { code: 'auth/unauthenticated', detail }
class TwoFactorRequiredError extends HTTPException {} // 403, cause { code: 'auth/two-factor-required', detail }

// @zukhruf/authentication/react-router
interface SessionClient<S> {
  getSession(options?: {
    fetchOptions?: { signal?: AbortSignal };
  }): Promise<{ data: S | null; error: { status: number } | null }>;
} // the member of a better-auth client that the package calls

type RequireSessionOptions<S extends { user: object }> = {
  readonly signIn: string;
} & ('twoFactorEnabled' extends keyof S['user']
  ? { readonly twoFactorSetup?: string }
  : { readonly twoFactorSetup?: never }); // `twoFactorSetup` only with better-auth's two-factor plugin

function requireSession<S extends { user: object }>(
  client: SessionClient<S>,
  request: Request,
  options: RequireSessionOptions<S>,
): Promise<S>;

interface SafeRedirectOptions {
  readonly origin: string;
  readonly fallback: string;
  readonly exclude?: readonly string[];
}
function safeRedirect(
  to: string | null | undefined,
  options: SafeRedirectOptions,
): string;

const REDIRECT_TO = 'redirectTo';
class AuthenticationUnavailableError extends Error {} // `cause`: the rejection or the error response
```

The package imports nothing from better-auth. `SessionSource` and `SessionClient` are structural, and `S` comes from the instance that the app passes, so `c.var.session` has the app's own user fields (`role`, `twoFactorEnabled`, …). The tests prove this against better-auth 1.7.26: a `betterAuth({ … })` instance and a `createAuthClient({ … })` client fit as they are.

The guard expects the default client, whose `getSession()` answers `{ data, error }`. A client made with `fetchOptions: { throw: true }` answers the session itself and throws on an error, so it does not type-check as a `SessionClient`.

## What a call does underneath

| Call                                        | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requireSession(auth)`                      | `auth.api.getSession({ headers: c.req.raw.headers })` once. `null` throws `UnauthenticatedError`; a session goes on `c.var.session`. An error of `getSession` (the database is down) reaches the app as it is                                                                                                                                                                                                                                                                                                                                                                 |
| `requireSession(auth, { twoFactor: true })` | as above, then `session.user.twoFactorEnabled !== true` throws `TwoFactorRequiredError`. better-auth gives no session to a user who turned two-factor on and did not enter the code, so a session either passed the second factor or belongs to a user who never turned it on                                                                                                                                                                                                                                                                                                 |
| React Router `requireSession`               | one `client.getSession({ fetchOptions: { signal: request.signal } })`. When React Router aborts the request, the abort is thrown as it is, and the router ignores it. Any other rejection, or an `error`, throws `AuthenticationUnavailableError`. No session throws `replace(signIn + '?redirectTo=' + path)`. A user without two-factor, when `twoFactorSetup` is given, throws `replace(twoFactorSetup + '?redirectTo=' + path)`. On the `twoFactorSetup` page itself the two-factor check passes, so the page never redirects to itself. Otherwise it returns the session |
| the return path                             | `pathname + search` of `request.url`. On a page in `signIn` or `twoFactorSetup` itself, the page's own safe `redirectTo` goes on, so no page sends a visitor back to sign in. A path longer than 2,048 characters is left out                                                                                                                                                                                                                                                                                                                                                 |
| `safeRedirect(to)`                          | the fallback, unless `to` starts with `/`, not with `//` or `/\`, is at most 2,048 characters, parses on `origin` to the same origin, and its path is not in `exclude`. Then the parsed `pathname + search + hash`, so a tab or newline that the parser drops cannot turn `/\t/evil.example` into `//evil.example`                                                                                                                                                                                                                                                            |

## Why not an npm package

Checked on 2026-11-19 (searches "better-auth hono middleware", "better-auth react-router", "hono session middleware better-auth"):

| Package                           | Weekly downloads | Why it does not do the job                                                                                                                                                                                    |
| --------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@hono/auth-js`                   | 21,599           | Auth.js sessions, not better-auth                                                                                                                                                                             |
| `@hono/clerk-auth`, `@clerk/hono` | 78,893, 116,817  | Clerk sessions; resolves only, never refuses                                                                                                                                                                  |
| `better-auth-cloudflare`          | 37,358           | Cloudflare Workers, D1 and KV setup; no guard                                                                                                                                                                 |
| `better-auth`                     | 20,758,844       | its Hono guide is a pattern to copy, not an export. Its `sessionMiddleware` and `freshSessionMiddleware` run inside its own endpoints, not in Hono. `better-auth/react` has `useSession`, but no loader guard |

Node has no session or authentication API (a search of the exports of every built-in module finds only TLS, inspector and SQLite sessions).

## Now, later, never

| Now                                                    | Later (two places today; waits for a third)                                                               | Never                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| a better-auth session on Hono: required                | a bearer JWT from a better-auth JWKS (text2sql v2 and desktop `authxPass`)                                | the sign-in methods, pages and emails                                      |
| two-factor required                                    | an API key (thing `authenticateApiKey`, text2sql v1)                                                      | users, roles, organizations: authorization is its own concept              |
| the React Router loader guard and the safe return path | a session younger than `freshAge`; a middleware that only reads the session (one place today: blackboard) | the tables and their migrations (better-auth's CLI and `@zukhruf/nx:auth`) |
|                                                        | React Router middleware (`context.set`), when a host uses it                                              | an identity provider                                                       |

## Who moves onto it

| Program                         | Its copy today                                                                                                                                                                                                                                                                                    | After                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| meddit (#4721, #4722)           | none                                                                                                                                                                                                                                                                                              | `requireSession(auth, { twoFactor: true })`; React Router `requireSession` with `twoFactorSetup`                                  |
| text2sql v1 (#4726)             | none: `authenticate` in `apps/backend/src/middlewares/middleware.ts` and `requiresAuth` in `apps/frontend/src/app/auth/auth-gate.ts` call `requireSession`, and `redirect-to.ts` is gone (75d4f320)                                                                                               | `requireSession(auth)`, and its team middleware reads `c.var.session`; the frontend keeps its setup check before `requireSession` |
| thing (#4727)                   | `authenticate` in `apps/backend/src/middlewares/middleware.ts`; `requiresAuth` in `apps/frontend` and `apps/pulse`                                                                                                                                                                                | `requireSession(auth)`; `authenticateEither` keeps its API-key branch and falls back to `requireSession`                          |
| blackboard (#4728)              | the `userId` middleware in `apps/api/src/app.ts`, which only reads the session ([ADR 0002](./docs/adr/0002-the-package-only-requires-a-session-and-better-auths-getsession-reads-one.md)); its loader that requires a session moved onto the package and `apps/web/src/auth.ts` is gone (d054ae7) | React Router `requireSession` and `safeRedirect`; its `redirect` query parameter becomes `redirectTo`                             |
| text2sql authx, v2, desktop     | an identity provider and its JWT clients                                                                                                                                                                                                                                                          | stay; the JWT is the "later" column                                                                                               |
| iworked, pm, Kortext regression | dormant or a client's repo                                                                                                                                                                                                                                                                        | left out (Ezz, 2026-11-19)                                                                                                        |

## Documentation

**Recipes**

- [Send a visitor back to the page they asked for after sign-in](./docs/recipes/send-a-visitor-back-after-sign-in.md)

**Decisions**

- [ADR 0001](./docs/adr/0001-the-package-is-zukhruf-authentication-an-island-that-takes-hono-and-react-router-as-peers.md): the package is @zukhruf/authentication, an island that takes Hono and React Router as peers.
- [ADR 0002](./docs/adr/0002-the-package-only-requires-a-session-and-better-auths-getsession-reads-one.md): the package only requires a session, and better-auth's getSession reads one.
- [ADR 0003](./docs/adr/0003-the-session-lands-on-the-context-as-better-auths-own-session-typed-by-a-generic-env.md): the session lands on the context as better-auth's own session, typed by a generic Env.
- [ADR 0004](./docs/adr/0004-a-refusal-is-an-httpexception-401-without-a-session-and-403-without-two-factor.md): a refusal is an HTTPException: 401 without a session, 403 without two-factor.
- [ADR 0005](./docs/adr/0005-the-route-guard-sends-the-path-and-query-as-redirectto-and-safe-redirect-keeps-it-on-the-origin.md): the route guard sends the path and query as redirectTo, and safeRedirect keeps it on the origin.
- [ADR 0006](./docs/adr/0006-a-failed-session-read-is-authentication-unavailable-never-signed-out.md): a failed session read is AuthenticationUnavailableError, never "signed out".
