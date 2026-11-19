# The route guard sends the path and query as redirectTo, and safeRedirect keeps it on the origin

Status: accepted by Ezz on 2026-11-19.

The three copies disagree. text2sql v1 sends `redirectTo` with the path and query, caps it at 2,048 characters, checks it with a same-origin URL parse, and never sends a visitor back to an auth page (`redirect-to.ts`). blackboard sends `redirect`, and checks only that it starts with `/` and not `//`. thing sends nothing. The leaders disagree too: Remix's stacks use `redirectTo` and keep the path only, React Router's v6 example uses `from` with no check, ASP.NET uses `ReturnUrl` with `Url.IsLocalUrl` (a leading `/`, not `//`, not `/\`), and Auth.js uses `callbackUrl`. Remix's `safeRedirect` misses `/\`, which a browser reads as `//`.

## Decision

- The parameter is `redirectTo` (`REDIRECT_TO`), the name of Remix's stacks and of text2sql v1.
- The return path is the `pathname + search` of the request: a page with a query (`/cases/42?tab=notes`) comes back whole. A return path longer than 2,048 characters is left out.
- On an auth page itself (the `signIn` or `twoFactorSetup` path), the guard forwards that page's own safe `redirectTo`, as text2sql v1's `appendRedirectTo`.
- `safeRedirect(to, { origin, fallback, exclude })` gives `to` only when it starts with `/`, not with `//` or `/\`, has at most 2,048 characters, parses on `origin` to the same origin, and its path is not in `exclude`. It then gives the parsed `pathname + search + hash`, never the raw string, so a tab or newline that the URL parser drops cannot make `/\t/evil.example` into `//evil.example`. Otherwise it gives `fallback`.
- The origin is an input, not `window.location`: the guard takes it from `request.url`, and a sign-in page passes `location.origin` in its own code.
- The guard throws React Router's `replace()`, as blackboard does, so the back button does not return to a page that only redirects again.

## Considered Options

- **The path only**, as Remix's stacks. A query is part of the page that a visitor asked for.
- **`startsWith('/') && !startsWith('//')`**, as Remix's `safeRedirect` and blackboard. It misses `/\` and the characters that the parser drops.
- **IsLocalUrl's rules and a same-origin parse, with text2sql v1's limits.** This option is proposed.

## Consequences

- blackboard's sign-in page reads `redirectTo` where it read `redirect`.
