# Each area has its own import path

The package began as one entry point that re-exported everything. Importing `timebox` from it loaded the SQL Server driver, the BigQuery client and DuckDB's native binding, and installing the package installed 116 packages, among them a native DuckDB binary of about 113 MB for each platform. Thus each area has its own import path, such as `@zukhruf/testing/docker` or `@zukhruf/testing/sqlserver`, and there is no root entry point. The three drivers are optional peer dependencies: a consumer installs the driver of each area it imports.

## Considered Options

- **One entry point with the drivers as dependencies.** It is the weight above, for every consumer.
- **One entry point with the drivers as optional peers.** Importing the entry point would load every driver, so it fails without all three.
- **A package for each area.** It is more to version and to release, for areas that share the Docker code.

## Consequences

- Postgres, MySQL and ClickHouse need no driver: they reach the server with `docker exec` and give the test a connection string.
- A test of the package imports each area in a process where the other areas' drivers cannot be resolved.
