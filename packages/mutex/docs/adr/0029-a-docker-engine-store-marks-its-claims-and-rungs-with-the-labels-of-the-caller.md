# A Docker engine store marks its claims and rungs with the labels of the caller

`DockerEngineStore` creates two kinds of Docker resources: a claim for each held key ([ADR 0026](./0026-a-docker-engine-key-is-a-named-container-that-lives-while-its-holder-attaches.md)), and the rungs of the ladder of each key ([ADR 0027](./0027-docker-engine-tokens-come-from-a-ladder-of-named-volumes.md)). Today, each claim and each rung has only the fixed labels of the store: `zukhruf.mutex.namespace`, `zukhruf.mutex.key` and `zukhruf.mutex.token`.

A cleanup finds Docker resources by their labels, never by their names. The run cleanup of `@zukhruf/testing` removes only the resources with the label `dev.zukhruf.testing.run=<id>` (`packages/testing/src/scripts/run-cleanup.ts`). It never accepts a name as proof that a resource belongs to the run. Thus, when a test process is killed, its claims and rungs stay on the engine:

- A rung always stays, because a volume never removes itself.
- A claim stays if it stopped in the state `created`.

On 2026-10-23, 5 claims in the state `created` stayed on the engine after loaded test runs.

**The decision.** `DockerEngineStoreOptions` gets the option `labels?: Readonly<Record<string, string>>`. The store puts these labels on each claim and on each rung. It writes its own labels (`zukhruf.mutex.namespace`, `zukhruf.mutex.key` and `zukhruf.mutex.token`) after the labels of the caller, so the caller cannot change them.

This is a production feature, not a seam for tests. An operator also finds the resources of the store by labels that the operator selects, for example the name of a team or of a deployment.

**Precedent.**

- Testcontainers puts its session label on each container that it starts, so that its reaper (Ryuk) can remove them after the session.
- Docker Compose puts the label `com.docker.compose.project` on each container, volume and network of a project.
- Kubernetes puts `ownerReferences` on a resource, and its garbage collector removes the resource when the referenced resource is deleted.

**How a test run uses it.** A test gives the labels of its run:

```ts
new DockerEngineStore({
  docker,
  image,
  namespace,
  heartbeatInterval,
  labels: (await new DockerTestbed({ environment: process.env }).defaults())
    .Labels,
});
```

The README of `@zukhruf/testing` gives `defaults()` as the seam for other container APIs. A call of `defaults()` also records the test process and, in a run, holds the run's reaper ([`@zukhruf/testing` ADR 0020](../../../testing/docs/adr/0020-a-reaper-container-removes-a-runs-engine-objects-when-the-attach-that-holds-it-closes-and-recovery-keeps-the-local-records.md), item 11). Thus the reaper removes what that process left after the run's last test process ends. In the code step, the test fixtures of the mutex give these labels: `src/testing/store-cases.ts`, the fixture in `docker-engine-store.test.ts`, and its child script `holderSource`. [ADR 0030](./0030-each-lock-store-runs-the-lock-store-contract-from-its-own-tests-and-a-capability-is-a-typed-parameter.md) deletes `src/testing/store-cases.ts`. The test fixture of `DockerEngineStore` is now in `src/testing/subjects/docker-engine.ts`, and it gives these labels.

**A removal of rungs by these labels is safe.** A cleanup by the labels of the caller can remove the ladder of a key. Since [ADR 0028](./0028-a-docker-engine-token-is-the-higher-of-the-engine-time-and-the-ladder.md), the tokens after a removed ladder start at the engine time, which is higher than each earlier token. Thus no rule about who may remove the rungs is necessary.

**A gap that is closed.** A create that is in progress when its process stops can finish after the run ended. Since `@zukhruf/testing` ADR 0020, the re-check passes of the run's reaper remove what such a create left. The store does not know test runs, and it must not know them.

## Considered Options

- **The sweep of each test by namespace only.** This is the current design. A test that is killed never gets to its sweep.
- **A run cleanup that removes by a name prefix.** The run cleanup never accepts a name as proof that a resource belongs to the run. Other software can use the same prefix.
- **A wrapper of the client that adds labels to each create.** `@zukhruf/docker` has no such seam. Also, the labels would then not be in the docs of the store.

## Consequences

- Each claim and each rung has the labels of the caller and the labels of the store.
- The run's reaper of `@zukhruf/testing` removes the claims and the rungs that a killed test process left, a few seconds after the run's last test process ended. The global teardown does not wait for it (`@zukhruf/testing` ADR 0020, item 5).
- The code step adds two tests:
  - "Every claim and rung carries the labels of the caller."
  - "A rung left by a killed test process is removed by the run's reaper after the run ends." It waits for the destroy events of the engine, from a time before the run, for each object it listed after the run. It runs `node --test` with the global setup of `@zukhruf/testing`, through the `DockerEngineStore` subject of the lock-store contract. Its shape is a copy of `packages/testing/src/scripts/docker-global-setup.integration.test.ts`.
