# The package is @zukhruf/authentication, an island that takes Hono and React Router as peers

Status: proposed, for review (#4717).

Six repositories run better-auth behind Hono: text2sql (v1 and authx), thing, blackboard, iworked and pm. Each one mounts the handler, reads the session in a middleware of its own, and turns a missing session into a 401 (text2sql v1, thing, iworked and pm). Three browser apps guard their pages with a loader that reads the session and redirects to sign-in (text2sql v1, blackboard, thing with two copies). That is strike four for the middleware and strike four for the guard (root [ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), rule 2). Ezz chose on 2026-11-19 to move them into zukhruf and to make the new Meddit app the first host, with only the active repositories migrating.

.NET keeps this concept in `Microsoft.AspNetCore.Authentication`, apart from `Microsoft.AspNetCore.Authorization`. RFC 9110, section 11, calls it HTTP authentication. Go has no standard package; go-chi keeps it in `jwtauth`. "Auth" alone is not the name, because it says authentication and authorization at once.

## Decision

- The package is `@zukhruf/authentication`, in `packages/authentication`, in the base layer (`std:base`, `layer:island`). It imports npm packages only.
- Two subpaths, one for each edge: `@zukhruf/authentication/hono` and `@zukhruf/authentication/react-router`. There is no root export: better-auth's `auth.api.getSession({ headers })` already is the part that needs no framework.
- `hono` and `react-router` are optional peer dependencies. The package imports nothing from `better-auth`: its types are structural, with only the members it calls (as `Clock` in root ADR 0004).
- Root ADR 0001 says that a package "imports no runtime of a host, such as Hono or Electron". This decision changes that sentence: a package may take a web framework as a peer, as the UI layer takes React, and still never imports a runtime that owns the process (Electron) or reads the environment. `islandConstraint([])` already bans nothing in this workspace, so the lint does not change.

## Considered Options

- **A framework-free core only** (functions over `Request`, `Headers` and `Response`), with each host writing its own Hono and React Router glue. It keeps the old sentence of root ADR 0001. But the glue is the knowledge that the copies repeat, so it would stay copied in every host.
- **Two packages**, `@zukhruf/authentication-hono` and `@zukhruf/authentication-react-router`. The two edges share one concept and change together (one session, one return path), so they are one package (root ADR 0001, rule 1).
- **`@zukhruf/better-auth`**, named after the tool. A package is named after its concept (`@zukhruf/nx` with `./format`, not `@zukhruf/prettier`), and the "later" column (a bearer JWT, an API key) is authentication too.
- **One package, two subpaths, framework peers.** This option is proposed.

## Consequences

- Root ADR 0001 gets the sentence above in the same commit as the package.
- An app installs `hono` or `react-router` itself; a server-only host never installs React Router.
