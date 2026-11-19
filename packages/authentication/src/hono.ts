import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

/**
 * The member of a better-auth instance that the middleware calls. A
 * `betterAuth({ … })` instance is one, and `S` is its session type, with the
 * app's own user fields.
 */
export interface SessionSource<S> {
  api: { getSession(context: { headers: Headers }): Promise<S | null> };
}

/**
 * `twoFactor` exists only when the session's user has `twoFactorEnabled`,
 * which better-auth's two-factor plugin adds, so an app without the plugin
 * cannot ask for it.
 */
export type RequireSessionOptions<S extends { user: object }> =
  'twoFactorEnabled' extends keyof S['user']
    ? { readonly twoFactor?: boolean }
    : { readonly twoFactor?: never };

/** A request without a session: 401, the caller signs in. */
export class UnauthenticatedError extends HTTPException {
  declare readonly cause: {
    code: 'auth/unauthenticated';
    detail: string;
  };

  constructor() {
    super(401, {
      message: 'Authentication required',
      cause: {
        code: 'auth/unauthenticated',
        detail: 'The request has no session',
      },
    });
    this.name = 'UnauthenticatedError';
  }
}

/** A session whose user has not turned two-factor on: 403, the caller sets it up. */
export class TwoFactorRequiredError extends HTTPException {
  declare readonly cause: {
    code: 'auth/two-factor-required';
    detail: string;
  };

  constructor() {
    super(403, {
      message: 'Two-factor authentication required',
      cause: {
        code: 'auth/two-factor-required',
        detail: 'The user has not turned on two-factor authentication',
      },
    });
    this.name = 'TwoFactorRequiredError';
  }
}

/**
 * Refuses a request without a session, and, with `twoFactor: true`, a session
 * whose user has not turned two-factor on. A request that passes has the
 * session on `c.var.session`. An error of `getSession` (the database is down)
 * reaches the app as it is.
 */
export function requireSession<S extends { user: object }>(
  auth: SessionSource<S>,
  options?: RequireSessionOptions<S>,
): MiddlewareHandler<{ Variables: { session: S } }> {
  return createMiddleware<{ Variables: { session: S } }>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session === null) throw new UnauthenticatedError();
    // better-auth gives no session to a user who turned two-factor on and has
    // not entered the code yet, so only a user who never turned it on is left.
    if (options?.twoFactor === true && !hasTwoFactor(session.user))
      throw new TwoFactorRequiredError();
    c.set('session', session);
    await next();
  });
}

// The same check as src/react-router.ts: a copy of one line (root ADR 0001
// keeps tiny helpers copied); change both together.
function hasTwoFactor(user: object): boolean {
  return 'twoFactorEnabled' in user && user.twoFactorEnabled === true;
}
