# @zukhruf/authentication

> Design for review (#4717). Nothing here is built. Ezz rules on each ADR before any code.

An app that signs its users in with [better-auth](https://www.better-auth.com) asks the same two questions on every request: who sent it, and may it pass. This package answers both at the edges of the app. On the server, a Hono middleware reads the better-auth session from the request and refuses a request without one. In the browser, a React Router loader sends a visitor without a session to the sign-in page, and brings them back to the page they asked for, never to another site.

better-auth owns the sign-in itself: the methods, the cookies, the tables and the second factor. This package only reads what better-auth decided.

The words in these documents have one meaning each. See the glossary in [GLOSSARY.md](./GLOSSARY.md).

## Use it

```sh
npm install @zukhruf/authentication hono react-router
```

### Refuse a request without a session (Hono)

```ts
import { Hono } from 'hono';

import { authentication, requireSession } from '@zukhruf/authentication/hono';

import { auth } from './auth.ts';

// betterAuth({ … })

const app = new Hono();

app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// A page that a guest may read: c.var.session is the session or null.
app.get('/api/shares/:id', authentication(auth), (c) => {
  const viewer = c.var.session?.user.id ?? null;
  // …
});

// Everything else needs a session, and a user with two-factor turned on.
app.use('/api/*', requireSession(auth, { twoFactor: true }));
app.get('/api/me', (c) => c.json(c.var.session.user)); // not null here
```

A request without a session gets `UnauthenticatedError` (401). A signed-in user without two-factor gets `TwoFactorRequiredError` (403). Both are `HTTPException`s, so the app's `onError` answers them as it answers every other `HTTPException` ([ADR 0004](./docs/adr/0004-a-refusal-is-an-httpexception-401-without-a-session-and-403-without-two-factor.md)).

### Send a visitor to sign in, and back (React Router)

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

A visitor on `/cases/42?tab=notes` without a session lands on `/sign-in?redirectTo=%2Fcases%2F42%3Ftab%3Dnotes`. When better-auth cannot answer (the network or the server is down), the loader throws `AuthenticationUnavailableError` for the route's error element, instead of sending a signed-in user to sign in ([ADR 0006](./docs/adr/0006-a-failed-session-read-is-authentication-unavailable-never-signed-out.md)).

## API

```ts
// @zukhruf/authentication/hono
interface SessionSource<S> {
  api: { getSession(context: { headers: Headers }): Promise<S | null> };
} // the member of a better-auth instance that the package calls

function authentication<S>(
  auth: SessionSource<S>,
): MiddlewareHandler<{ Variables: { session: S | null } }>;

function requireSession<S>(
  auth: SessionSource<S>,
  options?: { twoFactor?: boolean }, // `twoFactor` type-checks only when S's user has `twoFactorEnabled`
): MiddlewareHandler<{ Variables: { session: S } }>;

class UnauthenticatedError extends HTTPException {} // 401, cause.code 'auth/unauthenticated'
class TwoFactorRequiredError extends HTTPException {} // 403, cause.code 'auth/two-factor-required'

// @zukhruf/authentication/react-router
interface SessionClient<S> {
  getSession(): Promise<{ data: S | null; error: { status: number } | null }>;
} // the member of a better-auth client that the package calls

function requireSession<S>(
  client: SessionClient<S>,
  request: Request,
  options: { signIn: string; twoFactorSetup?: string }, // `twoFactorSetup` type-checks only when S's user has `twoFactorEnabled`
): Promise<S>;

function safeRedirect(
  to: string | null | undefined,
  options: { origin: string; fallback: string; exclude?: readonly string[] },
): string;

const REDIRECT_TO = 'redirectTo';
class AuthenticationUnavailableError extends Error {} // `cause`: the rejection or the error response
```

The package imports nothing from better-auth. `SessionSource` and `SessionClient` are structural, and `S` comes from the instance that the app passes, so `c.var.session` has the app's own user fields (`role`, `twoFactorEnabled`, …).

## What a call does underneath

| Call                                        | What happens                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `authentication(auth)`                      | `auth.api.getSession({ headers: c.req.raw.headers })` once, then `c.set('session', result)`. An error of `getSession` (the database is down) reaches the app as it is                                                                                                                                              |
| `requireSession(auth)`                      | uses `c.var.session` when `authentication` already ran, or reads it the same way. `null` throws `UnauthenticatedError`                                                                                                                                                                                             |
| `requireSession(auth, { twoFactor: true })` | as above, then `session.user.twoFactorEnabled !== true` throws `TwoFactorRequiredError`. better-auth gives no session to a user who turned two-factor on and did not enter the code, so a session either passed the second factor or belongs to a user who never turned it on                                      |
| React Router `requireSession`               | one `client.getSession()`. A rejection or an `error` throws `AuthenticationUnavailableError`. No session throws `replace(signIn + '?redirectTo=' + path)`. A user without two-factor, when `twoFactorSetup` is given, throws `replace(twoFactorSetup + '?redirectTo=' + path)`. Otherwise it returns the session   |
| the return path                             | `pathname + search` of `request.url`. On a page in `signIn` or `twoFactorSetup` itself, the page's own safe `redirectTo` goes on, so no page sends a visitor back to sign in. A path longer than 2,048 characters is left out                                                                                      |
| `safeRedirect(to)`                          | the fallback, unless `to` starts with `/`, not with `//` or `/\`, is at most 2,048 characters, parses on `origin` to the same origin, and its path is not in `exclude`. Then the parsed `pathname + search + hash`, so a tab or newline that the parser drops cannot turn `/\t/evil.example` into `//evil.example` |

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
| `authentication(auth)` | the authentication handler (`UseAuthentication`)                              | `Verifier(ja)`          | `getUserId(request)`     | `getAuthUser(c)`        |
| `requireSession(auth)` | `[Authorize]`, `RequireAuthorization()`                                       | `Authenticator(ja)`     | `requireUserId(request)` | `verifyAuth()`          |
| `{ twoFactor: true }`  | a policy with `RequireClaim("amr", "mfa")`; a failed policy is `Forbid` (403) | none                    | none                     | none                    |
| `UnauthenticatedError` | `Challenge` (401 or the login page)                                           | `http.Error(w, …, 401)` | `redirect('/login')`     | `HTTPException(401)`    |
| `REDIRECT_TO`          | `ReturnUrl`                                                                   | none                    | `redirectTo`             | `callbackUrl` (Auth.js) |
| `safeRedirect`         | `Url.IsLocalUrl`                                                              | none                    | `safeRedirect`           | none                    |

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

| Now                                                    | Later (two places today; waits for a third)                                | Never                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| a better-auth session on Hono: resolve and require     | a bearer JWT from a better-auth JWKS (text2sql v2 and desktop `authxPass`) | the sign-in methods, pages and emails                                      |
| two-factor required                                    | an API key (thing `authenticateApiKey`, text2sql v1)                       | users, roles, organizations: authorization is its own concept              |
| the React Router loader guard and the safe return path | a session younger than `freshAge`                                          | the tables and their migrations (better-auth's CLI and `@zukhruf/nx:auth`) |
|                                                        | React Router middleware (`context.set`), when a host uses it               | an identity provider                                                       |

## Who moves onto it

| Program                         | Its copy today                                                                                                                                      | After                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| meddit (#4721, #4722)           | none                                                                                                                                                | `requireSession(auth, { twoFactor: true })`; React Router `requireSession` with `twoFactorSetup`                                  |
| text2sql v1 (#4726)             | `authenticate` in `apps/backend/src/middlewares/middleware.ts` (session part); `requiresAuth` and `redirect-to.ts` in `apps/frontend/src/app/auth/` | `requireSession(auth)`, and its team middleware reads `c.var.session`; the frontend keeps its setup check before `requireSession` |
| thing (#4727)                   | `authenticate` in `apps/backend/src/middlewares/middleware.ts`; `requiresAuth` in `apps/frontend` and `apps/pulse`                                  | `requireSession(auth)`; `authenticateEither` keeps its API-key branch and falls back to `requireSession`                          |
| blackboard (#4728)              | `requireIdentity` and `redirectDestination` in `apps/web/src/auth.ts`; the `userId` middleware in `apps/api/src/app.ts`                             | React Router `requireSession` and `safeRedirect`; its `redirect` query parameter becomes `redirectTo`                             |
| text2sql authx, v2, desktop     | an identity provider and its JWT clients                                                                                                            | stay; the JWT is the "later" column                                                                                               |
| iworked, pm, Kortext regression | dormant or a client's repo                                                                                                                          | left out (Ezz, 2026-11-19)                                                                                                        |
