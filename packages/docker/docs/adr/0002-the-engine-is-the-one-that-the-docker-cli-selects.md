# The engine is the one that the Docker CLI selects

A person selects an engine with the Docker CLI: `docker context use`, `DOCKER_CONTEXT` or `DOCKER_HOST`. On 2026-10-20, the repositories that use Docker found their engine in three ways, and the three ways did not agree:

- `@zukhruf/testing/docker` asks the CLI: `docker context inspect --format '{{.Endpoints.docker.Host}}'`. It accepts a Unix socket, a Windows named pipe and an SSH engine.
- The finders of text2sql try two fixed sockets, `~/.docker/run/docker.sock` and `/var/run/docker.sock`, or `\\.\pipe\docker_engine` on Windows (`docker-engine.ts:41-56`). They find no engine of OrbStack, Colima or Rancher Desktop, which give their socket another path and add a context for it.
- The sandbox of `@deepagents/context`, finetuning and april start the CLI, and the CLI selects the engine.

Thus one person on one machine can get three engines from three tools.

The CLI selects the engine in this order ([`resolveContextName` in docker/cli](https://github.com/docker/cli/blob/master/cli/command/cli.go)):

1. `DOCKER_HOST`. It selects the `default` context with that host.
2. `DOCKER_CONTEXT`.
3. `currentContext` in `config.json` of the Docker configuration directory (`DOCKER_CONFIG`, or `~/.docker`).
4. The `default` context. Its host is `unix:///var/run/docker.sock`, or `npipe:////./pipe/docker_engine` on Windows.

The contexts are plain files ([the context store of docker/cli](https://github.com/docker/cli/blob/master/cli/context/store/store.go)). The metadata of a context is in `contexts/meta/<sha256 of its name>/meta.json`, and its host is the field `Endpoints.docker.Host`. On 2026-10-20 the store of the maintainer's Mac had `desktop-linux` (`unix:///Users/…/.docker/run/docker.sock`, the current context) and `limerence-dokploy` (`ssh://root@…`). The names of their directories were the SHA-256 of their names. A program can read the store with no CLI.

## Considered Options

- **Ask the CLI.** It gives the right engine, but it needs `docker` on the `PATH`. An app that starts from the macOS Dock does not have it (text2sql `304c5c51`).
- **Try fixed socket paths.** Testcontainers for Node.js and for Java try `DOCKER_HOST` and then a list of known sockets. docker-modem does the same. Neither one reads the contexts. Thus a person who selects a context gets another engine from the tests than from the terminal.
- **Read the context store in the order of the CLI.** The master branch of bollard does this. This option was selected.

## Consequences

- `Docker.connect()` selects the engine in the order above, from the context store and from the environment that the host program gives it (`environment: process.env`). The package itself reads no `process.env`: a zukhruf island takes such a value as an option, and the host reads its environment (the rule `island/no-process-env` of `@zukhruf/eslint`, as `TestRun.fromEnvironment(process.env)` of `@zukhruf/testing`). It starts no program for a local engine.
- `Docker.connect()` also takes a context name or a host. A context name ignores `DOCKER_CONTEXT` and `currentContext`. The `default` context still takes its host from `DOCKER_HOST`, because the Docker CLI defines the default context as the configuration of `DOCKER_HOST`. A host ignores the environment.
- `Docker.contexts()` lists each context, with its host. A product with its own rule chooses from the list. For example, the finders of text2sql want the engines of this machine only, because a container's published port on an SSH engine is on another machine.
- The package accepts three kinds of host: `unix://`, `npipe://` and `ssh://`. It refuses `tcp://`. An engine on TCP needs TLS files to be safe, and no consumer uses one. `@zukhruf/testing` refuses `tcp://` for the same reason today.
- For an SSH engine, the connection helper is `ssh -T -o BatchMode=yes <machine> docker system dial-stdio`, as in [the connhelper of docker/cli](https://github.com/docker/cli/blob/master/cli/connhelper/connhelper.go). `ssh` reads `~/.ssh/config`, so jump hosts, keys and agents work as they work for the CLI. The remote machine must have `docker` on the `PATH` of its SSH shell. The CLI needs that too.
- An app that starts from the Dock reads the same `config.json` as a terminal, so it gets the same current context. It does not get variables that a shell profile sets, such as a `DOCKER_HOST` in `~/.zshrc`. The CLI in a terminal does.
- The engine of a `Docker` client does not change. A process that wants another engine connects again.
