# The msw area is always strict and records each request

Tests that use msw start a server with `setupServer`, `listen` and `close` by hand. 27 files in 3 repositories push each request into an array by hand to assert on it. No place uses an unhandled-request strategy other than an error. msw 3.0.3 is the latest release and needs Node.js 22.12 or later. `SetupServerApi` has no `Symbol.dispose` in msw 2.15 or 3.0.2. Thus `new Msw().intercept(...handlers)` starts the server with `listen({ onUnhandledFrame: 'error' })` and returns an interception, `{ server, requests, cleanup, [Symbol.dispose] }`. There is no option for the strategy. `requests` holds a clone of each request, in the order of arrival, from the `request:start` event of `server.events`. `server` is the msw server, for `server.use()`. msw `^3.0.3` is an optional peer dependency and a development dependency.

## Considered Options

- **An option for the unhandled-request strategy.** No place uses a different strategy.
- **Pass loopback requests through by default.** 6 places pass them through, with a handler. A default would hide a request that a test did not expect. The README gives the handler as a recipe. The handler matches the origin of the local server, as in text2sql (``http.all(`${origin}/*`, () => passthrough())``). A catch-all handler, `http.all('*', …)`, that returns nothing for other hosts is not safe: on msw 3.0.2, msw then sends each unmatched request to the network, and the strict strategy has no effect.
- **No `server` in the handle.** 2 places call `server.use()`.
- **No `requests`.** Each of the 27 files then keeps its own array.
- **msw 2.** It has no `Symbol.dispose` either, and elt and cc move from 2.15 to 3 (#3038, #3039).

## Consequences

- A request that no handler answers fails the test that sent it. `fetch` rejects with the msw error "Cannot bypass a request when using the "error" strategy", and msw prints the method and the URL.
- A catch-all handler that returns nothing for some requests turns the strict strategy off. The area cannot see this, so a lint rule reports it.
- Known gap, not owned by this area: deepagents resets undici's global pool after `close` (2 places, 1 repository). A passthrough socket that sends nothing stays open. The reset uses the private `Symbol.for('undici.globalDispatcher.2')`, so this area does not do it.
- When a lint rule bans a direct `setupServer` in tests (#3028), the rule `require-msw-error-on-unhandled-request` is redundant: every interception is strict. #3028 removes it.
