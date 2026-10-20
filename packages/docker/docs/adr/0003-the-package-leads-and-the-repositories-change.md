# The package leads, and the repositories change

The first design of this package came from its call sites. Each part was to ship with the first repository that used it. A capability with no user waited "until a consumer needs it". That design kept the habits of the copies: handles that find a container by its name, and files that move as base64 text through an exec. The copies have these habits because the Docker CLI gave them no better way. The habits do not come from Docker.

On 2026-10-20 the maintainer decided the other way: "this new package drive the other repos not the otherwise". The package follows the Engine API, and the repositories that use Docker change to fit it.

The Rule of Three of zukhruf ([ADR 0001 of zukhruf](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), rule 2) still decided when this code moved here: more than three places do each operation. This ADR decides the shape of the code here.

## Considered Options

- **The shape of the call sites.** Each method does what one copy does today. The stdlib then keeps the habits of the CLI after it stops using the CLI.
- **The whole Engine API, generated from its specification.** [ADR 0001](./0001-the-client-speaks-the-engine-api-not-the-docker-cli.md) refuses this.
- **A complete design for the containers of one engine, and the resources around them: images, volumes, networks and events. The repositories change to use it.** This option was selected.

## Consequences

- The package ships its whole surface, with its own tests, before a repository changes. It does not ship one part for each consumer.
- Each repository gets a backlog item for its change. A change has no adapter and no compatibility layer.
- A capability is in the package, or out of it, for a reason of the domain. It is never out because no consumer uses it yet. These are out, each for its reason:
  - **Image builds and Compose.** A build with BuildKit needs its session protocol, and Compose is a plugin of the CLI. `docker.cliEnvironment` sends the CLI to the same engine.
  - **Engines on TCP.** Without TLS, an engine on TCP gives each machine that can reach it control of the host. TLS needs certificate files, and on 2026-10-20 no context in the maintainer's context store used TCP.
  - **Credential helpers.** A helper is a program on the `PATH`, such as `docker-credential-osxkeychain` ([ADR 0001](./0001-the-client-speaks-the-engine-api-not-the-docker-cli.md) explains the `PATH` problem). A pull or a push takes explicit credentials instead.
  - **A stop or a time limit for one exec.** The Engine API has no request that stops an exec.
  - **Output of an exec after a detach.** The engine keeps no output of an exec. microsandbox can do this with its jobs; Docker cannot.
  - **Swarm: services, tasks, nodes, secrets, configs.** They belong to a cluster, not to the containers of one engine.
- The other ADRs of this package came from this decision: [ADR 0004](./0004-a-handle-owns-its-container-only-when-it-created-it.md) for handles, [ADR 0005](./0005-output-is-one-stream-of-chunks-and-only-a-close-ends-the-input.md) for output and input, and [ADR 0006](./0006-files-move-through-the-archive-requests-not-through-exec.md) for files.
