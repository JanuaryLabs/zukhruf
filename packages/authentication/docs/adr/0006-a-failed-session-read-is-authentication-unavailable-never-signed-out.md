# A failed session read is AuthenticationUnavailableError, never "signed out"

Status: proposed, for review (#4717).

text2sql #1906: with its identity provider offline, the v2 app showed React Router's "Unexpected Application Error!", a stack trace and no way to recover on every page, because `requiresAuth` let the failed fetch through and the router had no error element. Treating the failure as "no session" is no better: it sends a signed-in user to the sign-in page, and the sign-in page fails the same way.

## Decision

- React Router's `requireSession` calls `client.getSession()` once. A rejection, or a result with an `error`, throws `AuthenticationUnavailableError` with the rejection or the error as its `cause`.
- Only `data: null` with no `error` means "no session" and redirects to sign-in.
- The package renders nothing. The host's route error element tells `AuthenticationUnavailableError` apart with `instanceof` and offers a retry.

## Considered Options

- **Let the error through**, as text2sql v2 did (#1906).
- **Treat it as signed out.** A signed-in user lands on a sign-in page that cannot load either.
- **A class of its own.** This option is proposed: it is the one failure whose next step is "try again".

## Consequences

- Each host that uses the guard has an error element on its protected routes.
- On the server, an error of `getSession` (the database is down) is not this class: it reaches the app's `onError` as it is, and answers 500.
