# Resolving a session and requiring one are two middlewares

Status: proposed, for review (#4717).

Each copy has one middleware that refuses: `authenticate()` in text2sql v1, thing, iworked and pm. Yet text2sql v1 also reads the session without refusing, in `routes/chat-shares.route.ts:191` and `routes/dashboard-shares.route.ts:61`, because a shared page shows more to a signed-in viewer. Those routes call better-auth by hand.

The leaders split the two. ASP.NET's authentication handler resolves the user, and `[Authorize]` refuses. go-chi's `Verifier` resolves and `Authenticator` refuses. Remix's indie-stack has `getUserId` and `requireUserId`. `@hono/auth-js` has `getAuthUser(c)` and `verifyAuth()`. Only Hono's own credential middlewares (bearer, basic, jwt) refuse without a resolve step, and they check a static credential, not a session.

## Decision

- `authentication(auth)` resolves: it sets `c.var.session` to the session or `null`, and never refuses.
- `requireSession(auth, options?)` requires: it throws when there is no session, or when an option is not met. It uses `c.var.session` when `authentication` ran earlier in the chain, so a request reads better-auth once.
- Both take the better-auth instance as their first argument, as go-chi takes `ja` and better-auth's guide closes over `auth`. Neither reads it from the context or from a module.

## Considered Options

- **One refusing middleware**, as the copies have. The shared pages keep calling better-auth by hand.
- **A resolver with a `required` flag.** One function gives two context types (`S | null` or `S`), and a flag picks between them.
- **Two middlewares.** This option is proposed.

## Consequences

- A route that reads an optional viewer uses `authentication(auth)`, and its handler checks `c.var.session` for `null`.
