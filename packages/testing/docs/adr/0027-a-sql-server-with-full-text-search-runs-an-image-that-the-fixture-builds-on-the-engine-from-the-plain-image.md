# A SQL Server with Full-Text Search runs an image that the fixture builds on the engine from the plain image

Status: accepted by Ezz on 2026-11-23 ("Accept"). The owner ruled on 2026-11-23 that the image goes into this package ("FTS image in testing (Recommended)"). The way to make the image, the option and the readiness below are the proposal. The code is not written.

`SqlServer` runs `SQL_SERVER_FULL_IMAGE`, `mcr.microsoft.com/mssql/server:2022-latest` ([sqlserver.ts](../../src/databases/sqlserver.ts)). That image has no Full-Text Search: `FULLTEXTSERVICEPROPERTY('IsFullTextInstalled')` is `0` in it (probe below), and also in `2025-latest` (17.0.5065.9, the probe of #5439). Thus a test cannot prove `CONTAINSTABLE` or `FREETEXTTABLE` on a real engine. Three consumers need it: `SqlServerKeywordRetriever` of `@zukhruf/retrieval` (#5399, step S7), the `ContextStore` of deepagents, which falls back to `LIKE` without it (#4884), and #5417.

The facts:

- **Microsoft publishes no image with Full-Text Search.** The tags of `mcr.microsoft.com/mssql/server` ([tag list](https://mcr.microsoft.com/v2/mssql/server/tags/list)) have no Full-Text variant. Microsoft installs it with the package `mssql-server-fts` ([Install SQL Server Full-Text Search on Linux](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-setup-full-text-search)), and its container sample is a Dockerfile that adds the package ([mssql-agent-fts-ha-tools](https://github.com/microsoft/mssql-docker/blob/master/linux/preview/examples/mssql-agent-fts-ha-tools/Dockerfile), linked from [Configure and customize SQL Server Docker containers](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-docker-container-configure)). That sample installs all of SQL Server 2017 on Ubuntu 16.04, so it is not a base for this package.
- **The package is in the repository of each major version.** [mssql-server-2022.list](https://packages.microsoft.com/config/ubuntu/22.04/mssql-server-2022.list) and [mssql-server-2025.list](https://packages.microsoft.com/config/ubuntu/22.04/mssql-server-2025.list) give `https://packages.microsoft.com/ubuntu/22.04/mssql-server-<year> jammy main`, signed by [microsoft.asc](https://packages.microsoft.com/keys/microsoft.asc). Each `mssql-server` version has an `mssql-server-fts` of the same version (36 of 36 in the 2022 repository, 19 of 19 in the 2025 repository, on 2026-11-23).
- **The image has no `mssql-server` package in dpkg.** The server version is in the label `com.microsoft.version` of the image (`16.0.4325.4` for `2022-latest`). `mssql-server-fts` depends on `mssql-server (>= 14.0.405.163-2)`, so `apt-get install mssql-server-fts` would also install a second server. The Dockerfile thus downloads the package of the label's version, and installs it with `dpkg --ignore-depends=mssql-server`.
- **Express has Full-Text Search on Linux.** The fixture sets `MSSQL_PID=Express`. "Full-text and semantic search" is "Yes" for Express ([editions of SQL Server 2022 on Linux](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-editions-and-components-2022), [2025](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-editions-and-components-2025)). The probe ran Express.
- **Other test tools take a custom image.** Testcontainers' SQL Server modules have no Full-Text variant. Java takes another image through `asCompatibleSubstituteFor` ([MSSQLServerContainer.java](https://github.com/testcontainers/testcontainers-java/blob/main/modules/mssqlserver/src/main/java/org/testcontainers/mssqlserver/MSSQLServerContainer.java)), Go takes the image as an argument of `Run` ([mssql module](https://golang.testcontainers.org/modules/mssql/)), and Node and Java build an image from a Dockerfile in the test run ([Node images](https://node.testcontainers.org/features/images/), [Java creating images](https://java.testcontainers.org/features/creating_images/)). Images with Full-Text Search on Docker Hub, such as [magicxor/mssql-fts](https://hub.docker.com/r/magicxor/mssql-fts), come from third parties.

## Decision

`new SqlServer({ environment, fullTextSearch: true })` runs SQL Server with Full-Text Search. The fixture builds the image on the engine from the `image` option, which is `SQL_SERVER_FULL_IMAGE` when the test gives none.

1. **The Dockerfile.** It is `src/databases/sqlserver-full-text-search.Dockerfile`, and the build of the package copies it into `dist`. Its arguments are `BASE` (the `image` option), `SERVER_VERSION` (the label `com.microsoft.version` of `BASE`) and `REPOSITORY` (`mssql-server-2022` for major version 16, `mssql-server-2025` for 17). This is the Dockerfile of the probe:

   ```dockerfile
   ARG BASE
   FROM ${BASE}
   ARG SERVER_VERSION
   ARG REPOSITORY
   USER root
   RUN set -eux; \
       . /etc/os-release; \
       wget -qO /etc/apt/keyrings/microsoft.asc https://packages.microsoft.com/keys/microsoft.asc; \
       echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.asc] https://packages.microsoft.com/ubuntu/${VERSION_ID}/${REPOSITORY} ${VERSION_CODENAME} main" > /etc/apt/sources.list.d/mssql-server.list; \
       apt-get update; \
       cd /tmp; \
       apt-get download "mssql-server-fts=${SERVER_VERSION}-*"; \
       dpkg --ignore-depends=mssql-server -i mssql-server-fts_*.deb; \
       rm -f mssql-server-fts_*.deb /etc/apt/sources.list.d/mssql-server.list; \
       rm -rf /var/lib/apt/lists/*
   USER mssql
   ```

2. **The version follows the plain image.** The tag of the built image is `zukhruf-testing-sqlserver-fts:<SERVER_VERSION>-<hash of the Dockerfile>`. A new `2022-latest` gives a new label, so a new tag; a change of `SQL_SERVER_FULL_IMAGE` changes it too. No second constant can go stale. The handle's `image` is the built tag, so the request of the shared server, and its fingerprint, differ from the plain server's ([ADR 0019](./0019-a-shared-servers-name-comes-from-its-request-and-the-global-teardown-removes-it-after-a-ttl.md)).
3. **A missing image is built, as a missing image is pulled.** The acquisition inspects the tag. When the engine has no image of that tag, it pulls `BASE` if necessary, reads its label, and builds through the Engine API ([ImageBuild](https://docs.docker.com/reference/api/engine/version/v1.47/#tag/Image/operation/ImageBuild)) with a context of one file. The build runs on the engine, so an SSH engine builds on its own host ([ADR 0024](./0024-a-run-holds-one-ssh-connection-to-an-ssh-engine-and-its-test-processes-reach-the-engine-host-through-it.md)). `@zukhruf/docker` has no `images.build()` now. That is a gap of the package, with the precedent of `pull`, `load` and `push` in its `Images`, and it is a separate change of that package.
4. **Readiness includes the full-text component.** After the `SELECT 1` of the readiness check, the fixture reads `FULLTEXTSERVICEPROPERTY('IsFullTextInstalled')` ([FULLTEXTSERVICEPROPERTY](https://learn.microsoft.com/en-us/sql/t-sql/functions/fulltextserviceproperty-transact-sql)). `1` is ready. `0` is not a wait: the image has no Full-Text Search, so the acquisition fails at once with the image in the message, and does not try again until the 180 s bound.
5. **The test waits for its population.** A population belongs to one index of the test, so the fixture does not wait for it. The test reads `OBJECTPROPERTYEX(OBJECT_ID('<table>'), 'TableFulltextPopulateStatus')` until `0` ([OBJECTPROPERTYEX](https://learn.microsoft.com/en-us/sql/t-sql/functions/objectpropertyex-transact-sql)). Microsoft deprecates the catalog property `PopulateStatus` and says not to poll it ([FULLTEXTCATALOGPROPERTY](https://learn.microsoft.com/en-us/sql/t-sql/functions/fulltextcatalogproperty-transact-sql)). The removed `waitForFtsReady` of the elt repository polled that property for the hard-coded catalog `context_store_catalog` (commit `d64fc577`, removed by #2336). A helper for the wait goes into the area only when three test suites have it ([ADR 0016](./0016-a-test-helper-goes-into-an-area-when-three-repositories-have-its-knowledge-and-it-does-not-use-mock.md)).

## The probe

The probe ran on 2026-11-23 on the `desktop-linux` engine (aarch64, 8 CPUs, 8 GB), with `linux/amd64` under emulation and `2022-latest` already on the engine.

1. `docker build --platform linux/amd64 --build-arg BASE=mcr.microsoft.com/mssql/server:2022-latest --build-arg SERVER_VERSION=16.0.4325.4 --build-arg REPOSITORY=mssql-server-2022 .`: exit 0 in 147 s. The download of `mssql-server-fts 16.0.4325.4-2` was 237 MB in 64 s.
2. `docker run` with the environment, the tmpfs and the memory of the fixture (`MSSQL_PID=Express`): "SQL Server is now ready for client connections" after 8 s, on the first of up to 3 starts.
3. `sqlcmd`: `Microsoft SQL Server 2022 (RTM-CU28) … 16.0.4325.4 (X64) … Express Edition (64-bit) on Linux (Ubuntu 22.04.5 LTS)`, `IsFullTextInstalled` = `1`.
4. `CREATE FULLTEXT CATALOG probe_catalog AS DEFAULT`, then `CREATE FULLTEXT INDEX ON passage (body LANGUAGE 1033) KEY INDEX pk_passage … WITH CHANGE_TRACKING AUTO` on 3 rows. `TableFulltextPopulateStatus` was `0` and `TableFulltextItemCount` `3` after 32 polls of 250 ms (about 8 s).
5. `CONTAINSTABLE(passage, body, N'"passage" OR "lease"')` gave rows 2 and 3, each with `RANK` 32.
6. The control: the plain `2022-latest` with the same environment gave `IsFullTextInstalled` = `0`.

## Considered Options

- **An image that Microsoft publishes.** Microsoft publishes none. An image of a third party has no owner that follows each cumulative update, and the test would run binaries that no one here reviewed.
- **A prebuilt image in a registry.** A workflow builds the Dockerfile and pushes the image, for example to GHCR, and the fixture pulls it with the pull that `#creating` of `DockerTestbed` already has. A first start then costs a pull, not a build. It lost because it needs a registry, credentials, a second release path beside npm ([root ADR 0007](../../../../docs/adr/0007-release-does-not-wait-for-ci.md)), and a rebuild for each cumulative update of the base. A public image also distributes SQL Server's binaries, which the license of Microsoft's image governs; that needs a reading of the license before it can be an option.
- **A second constant, `SQL_SERVER_FTS_IMAGE`.** A constant names an image that a pull can get. The built image has no registry, and its tag comes from the base, so an option of the fixture fits, as `tmpFs` does for `Postgres`.
- **Install the package in a running container.** An exec of `apt-get` in each new server costs the 237 MB download on each start, needs root in the container, and a shared server would start without Full-Text Search until the exec ends.

## Consequences

- The first `database()` with `fullTextSearch: true` on an engine pays the build: 147 s in the probe, plus the pull of the base when the engine has none. Like a pull, it counts in the time limit of the first test (300 s by default in `@zukhruf/nx/test`, see the README of this package). The build needs network access to `packages.microsoft.com` from the engine. Two processes that build the same tag at the same time both build; the second tag replaces the first with the same content.
- The image adds about 570 MB to the base (the `Installed-Size` of the package, 569633 KB).
- `@zukhruf/docker` gets `images.build()` first, in its own change.
- The 2025 image is not in the probe: under emulation it started 2 of 4 times in #5439. `REPOSITORY` maps major version 17 to `mssql-server-2025`, which the build of a test with `image: 'mcr.microsoft.com/mssql/server:2025-latest'` must prove.
