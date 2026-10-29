# A project with the tag test:docker gets the global setup of @zukhruf/testing

A Docker test starts containers through `@zukhruf/testing`. The global setup of `@zukhruf/testing/docker-global-setup` makes the test processes of one `node --test` process into one run. Its teardown removes what the run made, also when a test process was killed. The audit of 2026-10-29 found a Docker variant of the `test` target in 5 repos. These facts select the design:

- Node 26 resolves the value of `--test-global-setup` with `path.resolve(cwd, value)` (`internal/test_runner/utils`, `setupGlobalSetupTeardownFunctions`). A package name does not work. Any absolute path, or a path relative to `cwd`, works.
- Thus 5 repos keep a file that only re-exports the global setup: elt `docker-global-setup.ts`; factory `apps/factory/api/src/testing/docker-global-setup.ts`; deepagents `tools/src/docker-global-setup.ts`; text2sql `packages/adapters/src/testing/docker-global-setup.ts` and `apps/desktop/backend/src/testing/docker-global-setup.ts`.
- Two projects of zukhruf have a file that does more. mutex `packages/mutex/src/testing/docker-global-setup.ts` starts the shared servers before the run. `packages/testing/src/testing/docker-global-setup.ts` exports the package's own source, so its tests use the source and not `dist`.
- The global setup runs one time for each `node --test` process.
- The teardown is synchronous on purpose. Under `--test-force-exit`, Node does not wait for an asynchronous teardown (`packages/testing/src/scripts/docker-global-setup.ts:99-104`).
- The global setup sets `DOCKER_HOST` itself for the test processes.
- deepagents selects a remote engine by default, on purpose (d7876cc3).
- zukhruf and deepagents already use the tag `test:docker`.

## Considered Options

- **Signal: the tag `test:docker`.** ACCEPTED. Two repos already use it. The engine is a resource outside the files, so a person states it.
- **Signal: an import of `@zukhruf/testing` in the test files.** REJECTED. Import-based detection has exceptions ([ADR 0004](./0004-node-test-target-from-test-files.md)). mutex `packages/mutex/src/mutex/mutex.test.ts` imports `@zukhruf/testing/node`, which needs no engine.
- **Path: the project's own `src/testing/docker-global-setup.ts` wins.** ACCEPTED. mutex and `@zukhruf/testing` need their own file.
- **Path: else, `@zukhruf/testing/docker-global-setup` resolved from the project root, with the default conditions.** ACCEPTED. This gives `dist/scripts/docker-global-setup.js`. The plugin writes the path relative to the `cwd` of the target, `{projectRoot}`.
- **Path: the package name as the value.** REJECTED. Node reads the value as a path.
- **Path: a file in each repo that only re-exports the setup, as today.** REJECTED. It is 5 copies of one line. Each repo deletes its file when it migrates.
- **When the plugin cannot resolve the package, it runs the tests with no global setup.** REJECTED. A killed run then leaves its containers, and no run reports it. The plugin stops with an error.
- **Add `--test-force-exit`.** ACCEPTED. A Docker test can keep a handle open. The teardown is synchronous, so it runs also under force-exit.
- **Add `cache: false`.** ACCEPTED. The result depends on the engine, not only on the files. The base target has no cache too. `targetDefaults` and the project files come after the plugin, so a repo can still set `cache: true`. Thus `cache: false` is the default, not a guarantee.
- **The plugin sets or deletes `DOCKER_CONTEXT` or `DOCKER_HOST`.** REJECTED. The user, CI or the repo selects the engine. deepagents selects a remote engine on purpose. The global setup pins `DOCKER_HOST` itself.
- **The plugin calls the Docker CLI, or selects the engine when Nx makes the project graph.** REJECTED. The project graph must not depend on the engine. The global setup selects the engine when the run starts.
- **The plugin adds a second global setup.** REJECTED. A project's own file replaces the package setup. It does not add to it.
- **The plugin adds `--test-concurrency=1` or `"parallelism": false`.** REJECTED. Only an SSH engine that cannot take more needs them. They stay in each repo: `--test-concurrency=1` in the `flags` option or the `args` of a project, `"parallelism": false` in `targetDefaults` or a project file.

## Consequences

- A project with the tag `test:docker` gets `--test-global-setup=<path>`, `--test-force-exit` and `cache: false`, in addition to the base command of [ADR 0004](./0004-node-test-target-from-test-files.md).
- Each repo deletes its file that only re-exports the setup. mutex and `@zukhruf/testing` keep their own file.
- The plugin does not read or change the Docker environment. The same target runs on a local engine, on CI and on a remote engine.
- When this area ships, the `@zukhruf/testing` README changes. Its "A killed run" section tells each project to re-export the setup from one file. That text then tells a project to use the tag `test:docker`.
