# OpenSSH resolves the config through ssh -G

The `ssh` binary read `~/.ssh/config`, so jump hosts, keys, agents and the user's options worked for `@zukhruf/docker` as they work for the Docker CLI ([docker ADR 0002](../../../docker/docs/adr/0002-the-engine-is-the-one-that-the-docker-cli-selects.md)). The caller's `sshFlags` won over the config, because OpenSSH uses the first value it gets for an option ([docker ADR 0010](../../../docker/docs/adr/0010-ssh-gets-the-options-of-the-docker-cli-and-the-flags-of-the-caller.md)). A client in the Node process ([ADR 0002](./0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md)) loses both unless something resolves the config as OpenSSH does.

The OpenSSH config is a language: `Host` and `Match` blocks, `Match exec`, `Include`, `CanonicalizeHostname`, tokens such as `%h` and `%p`, and defaults that change with each release. The parser on npm, `ssh-config` 5.3.0, has no `Include`, runs `Match exec` only behind an option, has no defaults and expands no tokens (research `~/.claude/plans/zukhruf-ssh-4503-research.md`, step 1). `ssh -G` prints the settings after OpenSSH has read every block, and it makes no connection.

Tools that connect in their own process ask OpenSSH the same way (research, step 2):

- VS Code: `execFile('ssh', ['-G', '--', host])` and `parseSSHGOutput` (`sshRemoteAgentHostService.ts:1397`), then a connection with npm ssh2.
- distant (Rust, russh): "Tries ssh -G first (handles Match blocks, Include directives…)".
- zed, the GitHub CLI (`gh codespace`), coder, the Buildkite agent, trzsz-ssh, and nh of Nix.

A probe of OpenSSH 10.5p1 on 2026-11-17 showed the form of the output:

- One `key value` line for each setting, with lower-case keys. A setting with many values has many lines (`identityfile`, `sendenv`).
- `identityfile ~/.ssh/id_rsa` keeps the `~`. `userknownhostsfile` and `identityagent` are expanded (`/Users/ezzabuzaid/.ssh/known_hosts`).
- `proxycommand nc %h %p` keeps its tokens. `proxyjump alice@jump1:2200,jump2` is the list as given.
- `connecttimeout none` when no value is set. `proxyjump`, `proxycommand` and `identityagent` are absent when not set.
- `-o Include=…` fails: "Include directive not supported as a command-line option".
- `ssh -G` can write a warning to stderr and still exit 0.

## Decision

Ezz accepted this decision on 2026-11-17, together with [ADR 0003](./0003-ssh2-speaks-the-protocol.md) (backlog #4503): "Accept both (Recommended)".

`OpenSshConfig.resolve(destination, { flags, environment, signal })` of `@zukhruf/ssh/config` runs `ssh -G <flags> -- <destination>` and reads its standard output.

- The destination is OpenSSH's: `[user@]hostname[:port]`, an `ssh://` URI, or a `Host` name. `@zukhruf/docker` gives its `ssh://` host as it is.
- The flags are the caller's raw `ssh` flags. They keep the meaning that `sshFlags` has in `@zukhruf/docker`: they come first, so they win over the config file.
- `ssh -G` runs with the caller's environment ([ADR 0008](./0008-the-environment-and-the-clock-are-inputs.md)), and the signal stops it. A non-zero exit rejects with an `Error` whose message is the standard error of `ssh` and whose `cause` has the exit code. A warning on stderr with exit 0 is ignored.
- The package reads these settings:

  | Setting                                      | What the package does with it                                                                                                                                                                                                                                                                                                                                                           |
  | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `hostname`, `port`, `user`                   | The address of the TCP connection and the user of the handshake                                                                                                                                                                                                                                                                                                                         |
  | `hostkeyalias`                               | The name to look up in the known hosts, in place of the hostname                                                                                                                                                                                                                                                                                                                        |
  | `userknownhostsfile`, `globalknownhostsfile` | The files of `KnownHosts`, the user files first ([ADR 0005](./0005-host-keys-are-checked-as-gos-knownhosts-checks-them-under-openssh-stricthostkeychecking.md))                                                                                                                                                                                                                         |
  | `stricthostkeychecking`, `hashknownhosts`    | The host key policy, and the form of a line that the policy adds. `ssh -G` prints `true`, `false`, `ask` or `accept-new` (`multistate_strict_hostkey` in `readconf.c`); `strictHostKeyChecking` gives them as `'yes'`, `'no'`, `'ask'` and `'accept-new'`                                                                                                                               |
  | `hostkeyalgorithms`                          | The algorithms to offer, without those that ssh2 does not have, in the order of the known keys first                                                                                                                                                                                                                                                                                    |
  | `identityagent`                              | The agent socket. Absent or `SSH_AUTH_SOCK`: `SSH_AUTH_SOCK` of the environment. `none`: no agent                                                                                                                                                                                                                                                                                       |
  | `identityfile`, `identitiesonly`             | The identity files, with `~` expanded from `HOME` of the environment, and whether only their keys are offered from the agent                                                                                                                                                                                                                                                            |
  | `proxyjump`, `proxycommand`                  | The route: `jump` with the jump hosts, the first a `FirstJumpHost` with its own route and each later one a `JumpHost` with none ([ADR 0006](./0006-a-jump-host-is-a-connection-through-a-channel-of-the-previous-connection.md)), `proxy-command` with the ProxyCommand ([ADR 0010](./0010-a-proxycommand-runs-as-the-transport-of-the-connection.md)), or `direct` when neither is set |
  | `connecttimeout`                             | The connect timeout ([ADR 0007](./0007-keepalive-and-timeouts-come-only-from-the-resolved-config.md))                                                                                                                                                                                                                                                                                   |
  | `serveraliveinterval`, `serveralivecountmax` | The keepalive ([ADR 0007](./0007-keepalive-and-timeouts-come-only-from-the-resolved-config.md))                                                                                                                                                                                                                                                                                         |
  | `addressfamily`                              | IPv4 only, IPv6 only, or both, for the TCP connection                                                                                                                                                                                                                                                                                                                                   |
  | `setenv`, `sendenv`                          | `ClientConfig.sessionEnv`: each `SetEnv` variable, and each variable of the environment that a `SendEnv` pattern names. Each session sends them first, with no reply wanted, as OpenSSH sends them                                                                                                                                                                                      |
  | `forwardagent`                               | `ClientConfig.agentForwarding`, so every session asks for agent forwarding, as OpenSSH's `ForwardAgent yes` does. `yes`: each channel that the server opens back connects to `SSH_AUTH_SOCK` of the environment. A socket path, or a `$NAME` of the environment: that socket. `no`: no `agentForwarding` (Ezz 2026-11-17: "Honor it, as OpenSSH (Recommended)")                         |

- The rule for each other setting: the package honours a setting when to ignore it would connect to another host or accept a key that OpenSSH refuses. A setting that is ignored makes the client accept fewer keys or changes nothing that is checked. So `KnownHostsCommand`, `VerifyHostKeyDNS`, `CheckHostIP` and `UpdateHostKeys` are not read: without them, the client trusts only the known hosts files. Settings of a person's terminal are not read: `RequestTTY`, `LocalForward`, `RemoteForward`, `DynamicForward`, `ForwardX11`, `ControlMaster`, `ControlPath`. `BatchMode` is not read, because the package never prompts.
- The client never offers a password or keyboard-interactive auth from the config. It is batch, as the docker transport's `BatchMode=yes` was. The auth order is the agent, then the identity files. An encrypted identity file whose key the agent does not hold is skipped, as OpenSSH skips it in batch mode.
- `OpenSshConfig#dial({ clock, signal })` turns the resolved config into a client: a `KnownHosts` with the policy, the auth methods, the route, the connect timeout, the keepalive and the session env.

## Considered Options

- **The `ssh-config` package.** It has no `Include`, no defaults and no tokens. A host that resolves one way in a terminal resolves another way in the package.
- **A parser of our own.** It must follow each OpenSSH release: new defaults, new keys, the order of `Match` and `Include`, and canonicalization. OpenSSH already does this work.
- **No config: the caller builds a `ClientConfig`.** The root import path allows it. But each consumer then loses `~/.ssh/config`, which the docker transport gives today.
- **VS Code's mix: `ssh -G` for the config, and an `ssh -J … -W` child for each jump host** (`sshProxyJump.ts:107-114`). The child is a helper process ([ADR 0006](./0006-a-jump-host-is-a-connection-through-a-channel-of-the-previous-connection.md)).
- **`ssh -G` with the caller's flags.** This option was selected.

## Consequences

- `@zukhruf/ssh/config` needs the `ssh` binary. macOS and the common Linux distributions ship it in `/usr/bin`, which is on the `PATH` of launchd, so an app that starts from the macOS Dock finds it. Windows 10 and later ship it in `C:\Windows\System32\OpenSSH`. The root import path, `@zukhruf/ssh`, needs no binary.
- `ssh -G` is one process for each resolve. It ends before the connection opens, so it carries nothing ([ADR 0002](./0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md)). A `Match exec` of the user's config runs during `ssh -G`, as it runs for `ssh`.
- The keys of `ssh -G` output are a contract of OpenSSH, not of this package. A test of the package runs `ssh -G` on a config file of its own, with `-F`, and checks each key above.
- A setting that OpenSSH adds later is not read until the package reads it. By the rule above, an unread setting can only make the client accept fewer keys or change nothing that is checked. A new setting that changes the destination breaks the rule, and the package must read it.
