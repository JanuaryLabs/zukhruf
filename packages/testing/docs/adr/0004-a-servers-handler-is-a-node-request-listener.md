# A server's handler is a Node.js request listener

Tests bring two kinds of handler to an HTTP server: a Node.js request listener, `(request, response)`, and a fetch handler, `(Request) => Response`, from a web framework such as Hono or Better Auth. A fetch handler needs a bridge to Node.js. The bridge streams bodies in both directions, forwards aborts and keeps each `Set-Cookie` header. Each framework ships its bridge: `@hono/node-server` exports `getRequestListener`, which its own `serve()` uses, and `better-auth/node` exports `toNodeHandler`. Thus `start` and `background` take a request listener, and a test passes its framework's bridge.

Some handlers need the origin, for example an auth server whose base URL is its own origin. The listener reads a `const` that the test declares after the acquisition. No request arrives before that, because only the test knows the origin until it gives it to a client.

## Considered Options

- **An entry for fetch handlers.** The package would own a bridge that each framework already maintains, or depend on `@hono/node-server` and `hono`. A bridge that a consumer wrote by hand kept only the last `Set-Cookie` header and buffered each body.
- **An acquisition in two steps: listen, then serve a handler.** Between the steps the server listens but answers nothing, and a request waits.
- **A factory that receives the origin and returns the listener.** Some tests set environment variables and import modules between the origin and the listener. The factory would be asynchronous, with the same step between.

## Consequences

- A test with a fetch handler imports its framework's bridge.
- When the test declares the app after the acquisition, pass a function that reads it, such as `(request) => app.fetch(request)`. A bridge reads `app.fetch` or `auth.handler` when the test calls it, before that `const` exists.
