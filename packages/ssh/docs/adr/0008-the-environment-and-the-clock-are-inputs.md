# The environment and the clock are inputs

Two zukhruf rules apply to a base package:

- A library that waits on a timer or reads the time takes the clock as a required input, with no default ([root ADR 0004](../../../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md)). The lint rule `island/no-ambient-time` of `@zukhruf/eslint` reports a direct read of the time (`packages/eslint/src/island/plugin.ts:76`).
- An island reads no `process.env`. The host program gives its environment as an option (the rule `island/no-process-env` of `@zukhruf/eslint`). `@zukhruf/docker` takes `environment` this way ([docker ADR 0002](../../../docker/docs/adr/0002-the-engine-is-the-one-that-the-docker-cli-selects.md)).

The package waits on a timer in one place of its own: the connect timeout ([ADR 0007](./0007-keepalive-and-timeouts-come-only-from-the-resolved-config.md)). It needs the environment in `@zukhruf/ssh/config`:

- `ssh -G` reads `HOME`, `USER` and the variables that a `Match exec` or a `%` token uses ([ADR 0004](./0004-openssh-resolves-the-config-through-ssh-g.md)).
- The agent socket is `SSH_AUTH_SOCK` when `IdentityAgent` is absent or names that variable. ssh2 never reads `SSH_AUTH_SOCK` itself.
- `ssh -G` prints `identityfile ~/.ssh/id_rsa` with the `~` (probe, OpenSSH 10.5p1, 2026-11-17), and the package expands it from `HOME`.
- OpenSSH runs a ProxyCommand with `$SHELL`, and `SendEnv` sends variables of the local environment.

## Decision

Ezz accepted this decision on 2026-11-17, together with [ADR 0007](./0007-keepalive-and-timeouts-come-only-from-the-resolved-config.md) (backlog #4503): "Accept both (Recommended)".

The clock and the environment are inputs. The package reads neither from its process.

- `ClientConfig.clock` is required. Its type is `Clock` of `@zukhruf/async`. An app gives `globalThis`. A test gives `createClock()` of `@sinonjs/fake-timers`.
- `ServerConfig` has no clock. The server waits on no timer of its own, and the signal of `ServerConn.handshake` bounds a slow handshake ([ADR 0011](./0011-the-package-has-a-server-as-go-and-rust-do.md)). Root ADR 0004 asks a clock only of code that waits.
- `OpenSshConfig.resolve(destination, { environment })` requires the environment. `ssh -G` and a ProxyCommand run with it as their whole environment. The package reads these variables from it: `SSH_AUTH_SOCK`, `HOME`, `SHELL`, and the variables that `SendEnv` names.
- The root import path takes no environment. A caller of `Client.dial` connects the agent socket itself and gives it to `AgentClient` of `@zukhruf/ssh/agent`, as Go's `agent.NewClient(conn)` takes a connection.

## Considered Options

- **`process.env` and `globalThis` as defaults.** The lint rules refuse both, and a test could not run two clients with two environments in one process ([testing ADR 0009](../../../testing/docs/adr/0009-a-test-never-changes-the-environment-of-its-process.md)).
- **An optional environment, as in `@zukhruf/docker`.** Without it, `ssh -G` gets no `PATH` and no `HOME`, and the agent is never found. A silent empty environment gives a config that differs from the terminal's, so the input is required.
- **Required inputs.** This option was selected.

## Consequences

- A test runs two clients with two agents, or two homes, in one process.
- A test moves the connect timeout with a fake clock. The keepalive timer is ssh2's own, and it runs on real time ([ADR 0007](./0007-keepalive-and-timeouts-come-only-from-the-resolved-config.md)).
- `@zukhruf/docker` gives the environment that it already takes. When its caller gave none, docker gives an empty one, and `ssh -G` fails or finds no agent. That is docker's rule to state at its boundary.
