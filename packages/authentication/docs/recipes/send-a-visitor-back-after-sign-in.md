# Recipe: Send a visitor back to the page they asked for after sign-in

**Use case.** A visitor without a session opens a page behind sign-in, such as `/cases/42?tab=notes`. The app sends them to the sign-in page. After the sign-in, the visitor must land on `/cases/42?tab=notes` again, not on the home page. The return path travels in the query of the sign-in page, so anyone can write a link with another value. Without a check, a link such as `/sign-in?redirectTo=//evil.example` sends a visitor who just signed in to another site.

**What you need.** A session client (the better-auth client of the browser), the loader of each page that requires a session, and the sign-in page. Each page that signs a visitor in is an auth page, and a return path must never name one.

## The steps

1. In the loader of each page that requires a session, call `requireSession(client, request, { signIn: '/sign-in' })`. A guest gets React Router's `replace()` to the sign-in page, with the return path in the `redirectTo` query parameter (`REDIRECT_TO`).
2. On the sign-in page, read `REDIRECT_TO` from the query.
3. After the sign-in, give that value to `safeRedirect(to, { origin, fallback, exclude })`. Give the auth pages as `exclude`.
4. Navigate to what `safeRedirect` gives.

## The program

The program gives `requireSession` a session client that has no session, and a `Request` for `/cases/42?tab=notes`. It prints the redirect that the loader throws. Then it does what the sign-in page does after a sign-in: it reads the return path from that redirect and gives it to `safeRedirect`. Last, it gives `safeRedirect` return paths that someone wrote by hand.

```ts title="send-back.ts"
import {
  REDIRECT_TO,
  type SessionClient,
  requireSession,
  safeRedirect,
} from '@zukhruf/authentication/react-router';

type Session = { user: { id: string }; session: { id: string } };

// A session client with no session: the visitor is a guest.
const guest: SessionClient<Session> = {
  getSession: async () => ({ data: null, error: null }),
};

const origin = 'https://app.example';
const authPages = { signIn: '/sign-in' };

// 1. The loader of a page that requires a session sends the guest to sign in.
async function visit(path: string): Promise<string> {
  try {
    await requireSession(guest, new Request(origin + path), authPages);
    return 'the page loads';
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    return `${thrown.status} ${thrown.headers.get('Location')}`;
  }
}

const redirect = await visit('/cases/42?tab=notes');
console.log('guest on /cases/42?tab=notes ->', redirect);

// 2. After the sign-in, the sign-in page reads the return path, and
// safeRedirect keeps it on the origin and off the auth pages.
const signInUrl = new URL(redirect.split(' ')[1]!, origin);
const back = (to: string | null) =>
  safeRedirect(to, { origin, fallback: '/', exclude: ['/sign-in'] });
console.log(
  'after sign-in, go to',
  back(signInUrl.searchParams.get(REDIRECT_TO)),
);

// 3. A return path that someone wrote by hand gets the fallback.
for (const to of [
  '//evil.example',
  '/\\evil.example',
  '/\t/evil.example',
  'https://evil.example/cases',
  '/sign-in',
  null,
])
  console.log(JSON.stringify(to), '->', back(to));
```

Output:

```
guest on /cases/42?tab=notes -> 302 /sign-in?redirectTo=%2Fcases%2F42%3Ftab%3Dnotes
after sign-in, go to /cases/42?tab=notes
"//evil.example" -> /
"/\\evil.example" -> /
"/\t/evil.example" -> /
"https://evil.example/cases" -> /
"/sign-in" -> /
null -> /
```

## Why it works

`requireSession` writes the `pathname + search` of `request.url` as the return path, so the page comes back with its query (`?tab=notes`). It throws React Router's `replace()`, so the back button skips the page that only redirects ([ADR 0005](../adr/0005-the-route-guard-sends-the-path-and-query-as-redirectto-and-safe-redirect-keeps-it-on-the-origin.md)).

`safeRedirect` gives the return path only when it starts with `/`, not with `//` or `/\`, has at most 2,048 characters, parses on `origin` to the same origin, and its path is not in `exclude`. These are the rules of ASP.NET's `Url.IsLocalUrl`, with a same-origin parse. Then it gives the parsed path, query and hash, never the raw string. The URL parser drops a tab, so `/\t/evil.example` reads as `//evil.example`, and the parse catches it. Each other value gets the fallback. `src/react-router.test.ts` proves each case.

## Things to know

- **The origin is an input.** `requireSession` takes it from `request.url`. The sign-in page gives `location.origin` in its own code ([ADR 0005](../adr/0005-the-route-guard-sends-the-path-and-query-as-redirectto-and-safe-redirect-keeps-it-on-the-origin.md)).
- **Keep the list of auth pages in one place.** Each page that signs a visitor in gives the same `exclude`. text2sql keeps its list (`['/login', '/setup']`) in `apps/frontend/src/app/auth/auth-gate.ts`, and its login, setup and accept-invite pages all read `REDIRECT_TO` through one `returnPath` function on that list.
- **A guest on an auth page keeps that page's own return path.** When `requireSession` runs on the `signIn` or `twoFactorSetup` page itself, it forwards that page's safe `redirectTo`, never the auth page. When that value is not safe, `requireSession` sends no return path (`src/react-router.test.ts`).
- **A return path longer than 2,048 characters is left out.** `requireSession` sends the visitor to sign in with no return path, and `safeRedirect` gives the fallback.
- **`requireSession` sends no guest to sign in when it could not read the session.** A failed read throws `AuthenticationUnavailableError`, and an aborted read throws the abort as it is (#4745, [ADR 0006](../adr/0006-a-failed-session-read-is-authentication-unavailable-never-signed-out.md)). See the [README](../../README.md#errors) for the errors, and the [glossary](../../GLOSSARY.md) for the words.
