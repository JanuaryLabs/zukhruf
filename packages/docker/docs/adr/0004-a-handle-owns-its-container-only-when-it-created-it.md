# A handle owns its container only when it created it

A handle names one container on one engine. The first design had two problems with it:

- `containers.get(name)` gave a handle that removed the container on disposal. `await using db = docker.containers.get('shared-db')` then removed a server that other processes used.
- A handle kept the name that it got. Docker lets a new container take the name of a removed one. A handle that kept the name then acted on the replacement.

microsandbox, another sandbox SDK that the maintainer's repositories use, solves both. A `Sandbox` stops its sandbox on disposal only when `ownsLifecycle` is true (`dist/sandbox.js`, 0.7.8). Its handles keep a stable `id`, "so lifecycle calls on stale receivers refuse to act on a replacement that reused the name" (its README).

Four places create a container, or get the one that already has the name, by hand:

- `reuse()` of `@zukhruf/testing/docker`. It creates the container, accepts a 409, and polls the inspect, because "a competing create reserves the name before Docker registers it for inspection" (`docker.ts`).
- The named sandbox of `@deepagents/context` (`container-sandbox.ts:146`, which tries again after a race on the name for 1 second).
- `packages/bridge/src/db.ts` of april.
- `startContainer` of serverize (`packages/docker/src/lib/utils.ts:204-232`).

## Considered Options

- **A flag on each handle**, as `ownsLifecycle` of microsandbox. The flag is checked when the program runs, so `await using` on a handle that does not own its container compiles and then does nothing.
- **Two types.** Only an owned handle has `Symbol.asyncDispose`. This option was selected.

## Consequences

- `Container` names a container by the ID that the engine gave it, never by a name. `containers.find(nameOrId)` sends one inspect and gives a `Container` with that ID, or `undefined`.
- `OwnedContainer` extends `Container` with `Symbol.asyncDispose`, which removes the container with its anonymous volumes. Only `containers.create()` gives one, and `containers.createOrGet()` when it created the container. `await using` on a `Container` is a type error.
- `containers.createOrGet(body, { name })` gives `{ created: true, container: OwnedContainer }` or `{ created: false, container: Container }`. It handles the 409 and the short time in which the name is taken but the inspect does not find it yet. The container that exists wins, and its configuration is not compared, as in `connectOrCreate` of microsandbox. A product that needs the same configuration compares it itself: `@zukhruf/testing` compares a fingerprint label.
- Volumes and networks follow the same rule: `OwnedVolume`, `OwnedNetwork`, `find()` and `createOrGet()`. A volume has no ID, so its name names it.
- The Engine API creates a volume with a taken name without an error: it gives back the existing volume. Thus `volumes.create()` adds a creation label with a random value, and it compares the label of the answer. A different value means that the volume existed: `create()` rejects with status 409, and `createOrGet()` gives `created: false`.
- Images have no owner. An image is a cache that each container on the engine shares, so no handle removes one on disposal.
