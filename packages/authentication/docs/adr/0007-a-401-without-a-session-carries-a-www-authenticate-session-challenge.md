# A 401 without a session carries a WWW-Authenticate: Session challenge

Status: Accepted 2026-11-27 (backlog #5957).

Decision-makers: a subagent of the Meddit session, on the evidence below (Ezz picked #5957 to fix).

CATS 15.6.0 ran against Meddit (#5948) and found that a 401 of `requireSession` has no `WWW-Authenticate` header. RFC 9110 §15.5.2 says: "The server generating a 401 response MUST send a WWW-Authenticate header field (Section 11.6.1) containing at least one challenge applicable to the target resource." [ADR 0004](./0004-a-refusal-is-an-httpexception-401-without-a-session-and-403-without-two-factor.md) said "A cookie session sends no `WWW-Authenticate` header, as in `@hono/auth-js`", so the package broke that rule on purpose.

A better-auth session has no registered authentication scheme. The IANA registry that RFC 9110 §16.4.1 names has `Basic`, `Bearer`, `Digest` and others, but none for a cookie. The leaders answer a request without a session in one of three ways:

| Leader                         | Status for no session                   | Challenge                                                          |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------ |
| better-auth 1.7.27             | 401 (`sessionMiddleware`)               | none                                                               |
| ASP.NET Core cookie auth       | 401 for an API request, with `Location` | none                                                               |
| Devise                         | 401 for a JSON request                  | `Basic` only when `http_authenticatable` is on (default off)       |
| Laravel                        | 401 for a JSON request                  | none                                                               |
| passport with passport-local   | 401                                     | only a challenge string that a strategy gives; passport-local none |
| Spring `HttpStatusEntryPoint`  | 401                                     | none                                                               |
| Rails 8 authentication         | a redirect to sign-in                   | none                                                               |
| Django REST Framework          | 403 when the scheme has no challenge    | none, because the status is not 401                                |
| Hono `bearerAuth`, `basicAuth` | 401                                     | `Bearer realm=""`, `Basic realm="…"`                               |

Six of the nine send 401 and no challenge: the majority is the defect itself. Only Django REST Framework meets the RFC for a cookie session, and it does so by answering 403. passport, Devise, DRF and Hono share one mechanism: the authenticator of the scheme in use gives the challenge.

## Decision

- `requireSession` answers a request without a session with 401, as before, and sets `WWW-Authenticate: Session` on the context before it throws `UnauthenticatedError`.
- `Session` is the package's word for what better-auth's `getSession` reads. It is an unregistered scheme name. RFC 9110 §11.6.1 allows any `auth-scheme` token, and the header tells a client that a session, not `Basic` or `Bearer`, is missing.
- The header goes on the context (`c.header`), not on the exception's `res`. A host's `onError` that answers with `c.json(…)`, as the `@zukhruf/nx:node-app` template and Meddit do, keeps the context's headers and drops `res`. Hono's default error handler keeps them too.
- The 403 of `TwoFactorRequiredError` carries no challenge. RFC 9110 §15.5.4 sets no `WWW-Authenticate` rule for 403, and §11.6.1 makes it a MAY for every status other than 401. The user is signed in, so other credentials do not help. RFC 6750 §3.1 also answers `insufficient_scope` with 403, where the challenge is a MAY.

## Considered Options

- **Keep 401 with no challenge, as the majority does.** It breaks a MUST of RFC 9110, and a conformance check such as CATS flags it on every guarded route.
- **403 when there is no challenge, as Django REST Framework does.** 403 then means both "sign in" and "set up two-factor", and ADR 0004 gives each next step its own status. Every other leader, every client of the package and RFC 9110 §15.5.2 ("lacks valid authentication credentials") give a missing session 401.
- **A challenge that the host gives, as an option.** Only Meddit asked, and every host today signs in with a better-auth cookie. A host with better-auth's `bearer` plugin could want `Bearer` too; that host adds the option when it comes (Rule of Three, strike 1).
- **`Cookie` or `FormBased` as the scheme.** `FormBased` appears only in small projects (stashapp, geostore), and better-auth signs in by passkey and social providers too, not only by form. `Cookie` names a carrier, and better-auth's `bearer` plugin carries the same session in `Authorization`.

## Consequences

- Each 401 of `requireSession` now has `WWW-Authenticate: Session`. The status, the message and the `cause` stay the same, so no host changes.
- A host `onError` that builds a new `Response` without `c` drops the header. Both known host shapes keep it.
- A browser shows its own sign-in dialog only for a scheme it knows, such as `Basic`. It shows none for `Session`.

## Confirmation

- `src/hono.test.ts`: a request without a session, and one with a forged session cookie, get 401 and `WWW-Authenticate: Session` through an `onError` that answers with `c.json`, as a host does. An app with no `onError` gets the header through Hono's own error handler. The 403 of two-factor has no `WWW-Authenticate`. With the `c.header` line removed in memory (a Node `registerHooks` load hook, Node 26.13.1), the three 401 tests fail and the other ten pass.
- RFC 9110: §11.6.1, §15.5.2, §15.5.4, §16.4.1. RFC 6750: §3, §3.1.
- better-auth 1.7.27 `dist/api/routes/session.mjs:295-301` (`APIError.from("UNAUTHORIZED")`, no header).
- ASP.NET Core `src/Security/Authentication/Cookies/src/CookieAuthenticationEvents.cs:45-57` (main): `StatusCode = 401` and `Location`.
- Devise `lib/devise/failure_app.rb:52-57, 204-206` (main).
- Laravel `src/Illuminate/Foundation/Exceptions/Handler.php:759-764` (12.x).
- passport `lib/middleware/authenticate.js:156-173` (master); passport-local `lib/strategy.js:108` gives `fail(info)` with an object.
- Spring Security `web/…/HttpStatusEntryPoint.java:51` (main): the status only.
- Rails `railties/…/authentication/templates/app/controllers/concerns/authentication.rb.tt:32-35` (main): `redirect_to new_session_path`.
- Django REST Framework `rest_framework/views.py:459-466` (master): no `authenticate_header`, so 403; `SessionAuthentication` has none (`authentication.py:112`); `docs/api-guide/authentication.md:82`.
- Hono 4.13.20 `dist/middleware/bearer-auth/index.js:53`, `dist/middleware/basic-auth/index.js:84`; `dist/hono-base.js:16-20` and `dist/context.js:256-257` keep the context's headers on the error response.
