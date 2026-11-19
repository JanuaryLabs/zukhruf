# The package only requires a session, and better-auth's getSession reads one

Status: accepted by Ezz on 2026-11-19 ("Drop it (Recommended)").

Each copy has one middleware that refuses: `authenticate()` in text2sql v1, thing, iworked and pm. The leaders split reading from refusing: ASP.NET's authentication handler and `[Authorize]`, go-chi's `Verifier` and `Authenticator`, Remix's `getUserId` and `requireUserId`, `@hono/auth-js`'s `getAuthUser(c)` and `verifyAuth()`. Their frameworks have no one-line read, so the read needs its own handler.

better-auth has that read: `auth.api.getSession({ headers })` gives the session or `null`. The places that read without refusing show what a resolver would add:

- text2sql v1 `routes/chat-shares.route.ts:190` and `routes/dashboard-shares.route.ts:61` refuse only when a share is visible to a team, which the handler knows after it loads the share. They call `auth.api.getSession` and decide in the handler. A middleware that only reads would not move that decision.
- blackboard `apps/api/src/app.ts:222` sets `userId` from the session and never refuses. It is the one middleware that only reads: strike 1.

## Decision

- The package exports `requireSession(auth, options?)` and no resolver. It reads the session with `auth.api.getSession` and throws when there is none, or when an option is not met.
- A route that reads a session without refusing calls `auth.api.getSession({ headers: c.req.raw.headers })` itself. better-auth already does that job.
- `requireSession` takes the better-auth instance as its first argument, as go-chi takes `ja` and better-auth's guide closes over `auth`. It does not read it from the context or from a module.

## Considered Options

- **Two middlewares, `authentication(auth)` and `requireSession(auth)`**, as the leaders split them. The read half repeats `auth.api.getSession` in one line, and only one place uses it.
- **A resolver with a `required` flag.** One function would give two context types (`S | null` or `S`), and a flag would pick between them.
- **`requireSession` only.** This option was selected.

## Consequences

- A resolver middleware goes in the "later" column. It comes when a third place reads the session in a middleware without refusing.
- blackboard keeps its `userId` middleware on `auth.api.getSession` (#4728 migrates its route guard, not that middleware).
