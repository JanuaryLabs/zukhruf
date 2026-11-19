import { replace } from 'react-router';

/**
 * The member of a better-auth client that the guard calls. A
 * `createAuthClient({ … })` client is one, with its default `{ data, error }`
 * results. A client made with `fetchOptions: { throw: true }` gives the
 * session itself and is not one.
 */
export interface SessionClient<S> {
  getSession(options?: {
    fetchOptions?: { signal?: AbortSignal };
  }): Promise<{ data: S | null; error: { status: number } | null }>;
}

/**
 * `twoFactorSetup` exists only when the session's user has
 * `twoFactorEnabled`, which better-auth's two-factor plugin adds.
 */
export type RequireSessionOptions<S extends { user: object }> = {
  readonly signIn: string;
} & ('twoFactorEnabled' extends keyof S['user']
  ? { readonly twoFactorSetup?: string }
  : { readonly twoFactorSetup?: never });

export interface SafeRedirectOptions {
  readonly origin: string;
  readonly fallback: string;
  readonly exclude?: readonly string[];
}

/** The query parameter that carries the return path. */
export const REDIRECT_TO = 'redirectTo';

const MAX_RETURN_PATH = 2048;

/**
 * The browser could not read the session: the network failed, or better-auth
 * answered with an error. It is not "signed out"; the caller tries again.
 */
export class AuthenticationUnavailableError extends Error {
  constructor(options: { cause: unknown }) {
    super('The session could not be read', options);
    this.name = 'AuthenticationUnavailableError';
  }
}

/**
 * The session of a protected page's loader. A visitor without one is sent to
 * `signIn` with the page as the return path, and, with `twoFactorSetup`, a
 * user who never turned two-factor on is sent there. Both throw React
 * Router's `replace()`, so the back button skips the page that redirected.
 * The read follows `request.signal`: when React Router aborts the request,
 * the abort is thrown as it is, neither "no session" nor unavailable.
 */
export async function requireSession<S extends { user: object }>(
  client: SessionClient<S>,
  request: Request,
  options: RequireSessionOptions<S>,
): Promise<S> {
  let result: Awaited<ReturnType<SessionClient<S>['getSession']>>;
  try {
    result = await client.getSession({
      fetchOptions: { signal: request.signal },
    });
  } catch (cause) {
    // React Router ignores what a request it aborted throws.
    if (request.signal.aborted) throw cause;
    throw new AuthenticationUnavailableError({ cause });
  }
  if (result.error !== null)
    throw new AuthenticationUnavailableError({ cause: result.error });

  const url = new URL(request.url);
  const authPages = [options.signIn, options.twoFactorSetup]
    .filter((page) => page !== undefined)
    .map((page) => new URL(page, url).pathname);

  if (result.data === null)
    throw replace(withReturnPath(options.signIn, url, authPages));
  const setup = options.twoFactorSetup;
  // The setup page itself passes, or it would redirect to itself forever.
  if (
    setup !== undefined &&
    !hasTwoFactor(result.data.user) &&
    url.pathname !== new URL(setup, url).pathname
  )
    throw replace(withReturnPath(setup, url, authPages));
  return result.data;
}

/**
 * `to` when it is a path on `origin` that is not in `exclude`, otherwise
 * `fallback`. The answer is the parsed path, query and hash, never the raw
 * string, so a character that the URL parser drops cannot turn it into
 * another site.
 */
export function safeRedirect(
  to: string | null | undefined,
  options: SafeRedirectOptions,
): string {
  return (
    safePath(to, options.origin, options.exclude ?? []) ?? options.fallback
  );
}

function safePath(
  to: string | null | undefined,
  origin: string,
  exclude: readonly string[],
): string | undefined {
  if (to === null || to === undefined) return undefined;
  if (!isLocal(to) || to.length > MAX_RETURN_PATH) return undefined;
  const base = new URL(origin);
  const parsed = URL.parse(to, base);
  if (parsed === null || parsed.origin !== base.origin) return undefined;
  if (exclude.includes(parsed.pathname)) return undefined;
  const path = parsed.pathname + parsed.search + parsed.hash;
  // The parser folds `/.//evil.example` into `//evil.example`.
  return isLocal(path) ? path : undefined;
}

/** A leading `/`, not `//` or `/\`, as ASP.NET's `Url.IsLocalUrl`. */
function isLocal(path: string): boolean {
  return (
    path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')
  );
}

function withReturnPath(
  page: string,
  url: URL,
  authPages: readonly string[],
): string {
  // On an auth page, the page's own return path goes on, so no page sends a
  // visitor back to sign in.
  const returnPath = authPages.includes(url.pathname)
    ? safePath(url.searchParams.get(REDIRECT_TO), url.origin, authPages)
    : url.pathname + url.search;
  if (
    returnPath === undefined ||
    !isLocal(returnPath) ||
    returnPath.length > MAX_RETURN_PATH
  )
    return page;
  const separator = page.includes('?') ? '&' : '?';
  return `${page}${separator}${new URLSearchParams({ [REDIRECT_TO]: returnPath })}`;
}

// The same check as src/hono.ts: a copy of one line (root ADR 0001 keeps tiny
// helpers copied); change both together.
function hasTwoFactor(user: object): boolean {
  return 'twoFactorEnabled' in user && user.twoFactorEnabled === true;
}
