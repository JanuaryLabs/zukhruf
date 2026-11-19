# Authentication

The two edges of an app where it learns who sent a request: the Hono server and the React Router browser app. better-auth owns the sign-in; this package reads its result. The words below have one meaning each in its documents.

## Language

**Session**:
What better-auth's `getSession` gives for a signed-in request: `{ user, session }`, with the app's own user fields. Its type comes from the app's better-auth instance.
_Avoid_: Identity, subject, principal, auth user

**Session source**:
The better-auth instance on the server, seen only through `api.getSession`.
_Avoid_: Auth, auth server, provider

**Session client**:
The better-auth client in the browser, seen only through `getSession`.
_Avoid_: Auth client, SDK

**Resolve**:
To read the session of a request and keep it, or `null`, on the context. Resolving never refuses.
_Avoid_: Verify, load, authenticate

**Require**:
To refuse a request whose session is missing or does not meet a requirement.
_Avoid_: Protect, guard, authorize

**Two-factor**:
better-auth's second factor: a code from an authenticator app, or a backup code. A user has turned it on when `user.twoFactorEnabled` is true.
_Avoid_: 2FA, MFA, step-up, second step

**Refusal**:
The error that a requirement throws: `UnauthenticatedError` or `TwoFactorRequiredError`.
_Avoid_: Rejection, denial

**Return path**:
The path and query of the page that a visitor asked for before sign-in. It travels in the `redirectTo` query parameter.
_Avoid_: Callback URL, return URL, next, from

**Auth page**:
A page that a return path must never name, because it would send the visitor back to sign in: the sign-in page and the two-factor setup page.
_Avoid_: Auth surface, login route

**Unavailable**:
The state in which the browser could not read the session at all: the network failed or better-auth answered with an error. It is not "signed out".
_Avoid_: Offline, logged out, expired
