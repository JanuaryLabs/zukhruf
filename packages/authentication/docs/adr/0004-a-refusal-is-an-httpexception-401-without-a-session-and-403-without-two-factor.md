# A refusal is an HTTPException: 401 without a session, 403 without two-factor

Superseded in part on 2026-11-27 (#5957) for the challenge. A 401 of `requireSession` now carries `WWW-Authenticate: Session`, because RFC 9110 §15.5.2 requires a challenge on each 401 ([ADR 0007](./0007-a-401-without-a-session-carries-a-www-authenticate-session-challenge.md)). The sentence "A cookie session sends no `WWW-Authenticate` header" no longer holds. The rest of the decision stays true.

Status: accepted by Ezz on 2026-11-19.

The copies throw `new HTTPException(401, { message: 'Authentication required', cause: { code: 'api/unauthenticated', detail } })` (thing, pm, iworked, text2sql v1). An `@zukhruf/nx:node-app` backend answers every `HTTPException` in its `onError` with `{ error: message, cause }` and its status. `@hono/auth-js`, `hono/jwt`, `hono/basic-auth` and `hono/bearer-auth` also throw `HTTPException(401)`. A cookie session sends no `WWW-Authenticate` header, as in `@hono/auth-js`.

Meddit requires two-factor for every user (Ezz, 2026-11-19). better-auth's two-factor plugin deletes the session of a password sign-in by a user who turned two-factor on, until the code is entered. So "signed in, code not entered yet" has no session, and is a 401. The one state left is a signed-in user who never turned two-factor on (`user.twoFactorEnabled` is false). ASP.NET answers a failed policy with `Forbid` (403), Clerk answers a failed reverification with 403, and better-auth answers a session that is not fresh with 403.

## Decision

- `UnauthenticatedError extends HTTPException`: status 401, message `Authentication required`, `cause: { code: 'auth/unauthenticated', detail }`.
- `TwoFactorRequiredError extends HTTPException`: status 403, message `Two-factor authentication required`, `cause: { code: 'auth/two-factor-required', detail }`.
- `requireSession(auth, { twoFactor: true })` throws the second one. The option type-checks only when the session's user has a `twoFactorEnabled` field, so an app without better-auth's two-factor plugin cannot ask for it.
- A class exists for each next step of the caller: sign in, or set up two-factor. The codes take better-auth's prefix (`auth/`), as text2sql v1 already maps better-auth's own errors.

## Considered Options

- **The package's own `Error` classes**, which each host maps to a response. Each host's `onError` would need a new branch.
- **`HTTPException` subclasses.** This option is proposed: the existing branch answers them, and `instanceof` still tells them apart.
- **401 for two-factor too**, as RFC 9470's step-up challenge for OAuth bearer tokens. That RFC asks a client to authenticate again with a stronger method. Here the user is authenticated and must first set two-factor up, which is a forbidden request, not a new challenge.

## Consequences

- The code of a 401 changes from `api/unauthenticated` to `auth/unauthenticated` in thing and text2sql v1. A client that reads the old code changes with it.
