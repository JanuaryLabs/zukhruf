# The session lands on the context as better-auth's own session, typed by a generic Env

Status: proposed, for review (#4717).

The copies set two variables, `session` and `subject` (the user), and type them with `InferSession<typeof auth>` and `InferUser<typeof auth>`, or `typeof auth.$Infer.Session.*`. better-auth's Hono guide sets one variable, `session`, whose value is `getSession`'s own result, `{ user, session }`, typed `typeof auth.$Infer.Session | null` through `createMiddleware<Env>`.

Hono's own packages export a variables type for a generic `Env` (`JwtVariables<T>`), and they also augment `ContextVariableMap` for the whole program. `@hono/auth-js` and `@hono/clerk-auth` augment it too. A global augmentation types `c.var.session` in routes that never ran the middleware, and it cannot carry the app's own session type.

## Decision

- One variable, `session`, holding `getSession`'s result as it is. `c.var.session.user` is the user and `c.var.session.session` is the session row, as in better-auth's guide.
- The middlewares return `MiddlewareHandler<{ Variables: { session: S | null } }>` and `MiddlewareHandler<{ Variables: { session: S } }>`. Hono merges the `Env` of each middleware into the routes after it, so a route behind `requireSession` sees `S`.
- `S` is inferred from the instance's `api.getSession`. The package declares no `ContextVariableMap` augmentation.

## Considered Options

- **`session` and `subject`**, as the copies. "Subject" is our own word, and better-auth's guide does not use it.
- **`user` and `session` as two variables.** It splits one result in two, so a handler that needs both reads two variables.
- **One `session`, as better-auth's guide.** This option is proposed.

## Consequences

- The migrating hosts read `c.var.session.user` where they read `c.var.subject`.
