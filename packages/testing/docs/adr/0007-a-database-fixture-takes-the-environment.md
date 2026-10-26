# A database fixture takes the environment

`Postgres`, `Mysql`, `Mariadb`, `SqlServer` and `ClickHouse` take the `environment`, such as `process.env`. Each instance makes its own `DockerTestbed` from it. The environment selects the engine and the run. Library code does not read `process.env`, so the caller gives the environment.

Every Testcontainers library gives a database module only its configuration. The module then gets the engine client itself:

- Java: `new PostgreSQLContainer<>(image)` gets the client from the `DockerClientFactory` singleton.
- Node: `new PostgreSqlContainer(image)` gets the client from `getContainerRuntimeClient()`.
- Go: `postgres.Run(ctx, image)` gets the client itself.
- Python: `PostgresContainer(image)` makes one client for each container.

This package follows Python: one `DockerTestbed` for each instance. The instance connects to the engine on the first acquisition, not before. Idle sockets do not keep the process running.

`DockerTestbed` stays public. A test uses it for a container that is not a database: `start`, `serve`, `reuse`, `run`, `volume`, `directory` and `client`.

## Considered Options

- **Keep the `docker` option.** The caller makes a `DockerTestbed` only to give it to the database fixture. The caller does not use it for other work. No Testcontainers library does this.
- **One shared `DockerTestbed` for each environment, in a cache.** Instances that use the same environment then use one connection. No measurement shows that more connections cause a problem. A cache adds state that a test cannot see.

## Consequences

- Each database fixture instance has its own connection to the engine. Two instances in one process make two connections.
- A test that also reads the engine, for example to find a container, makes its own `DockerTestbed` from the same environment.
- A handle keeps the engine it was created on. A change to the environment after the acquisition does not move the handle.
