# ssh2 speaks the protocol

[ADR 0002](./0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md) puts the SSH protocol inside the Node process. The protocol is large: the version exchange, the key exchange and its ciphers (RFC 4253), the user authentication (RFC 4252), the channels (RFC 4254), and the extensions of OpenSSH (`PROTOCOL`). Node v26.13.0 has no SSH module.

A search of npm on 2026-11-17 (research `~/.claude/plans/zukhruf-ssh-4503-research.md`, step 1) found these candidates:

| Package                      | Last release | Downloads a week | Packages | Verdict                                                                       |
| ---------------------------- | ------------ | ---------------- | -------- | ----------------------------------------------------------------------------- |
| `ssh2` 1.17.0                | 2025-08-20   | 21.2M            | 8        | The protocol, with streamlocal, direct-tcpip, exec, agent auth and a server   |
| `node-ssh` 14.0.0            | 2026-11-16   | 467k             | 12       | Wraps ssh2 and adds nothing that this package needs                           |
| `ssh2-promise` 1.0.3         | 2022-06-19   | 23k              | 14       | No streamlocal; stale                                                         |
| `tunnel-ssh` 5.2.0           | 2024-12-15   | 406k             | 9        | A port-forward helper                                                         |
| `@microsoft/dev-tunnels-ssh` | 2026-08-24   | 46k              | 13       | Its own stack; no agent client, no streamlocal message                        |
| `ssh-config` 5.3.0           | 2026-09-11   | 234k             | 1        | A parser; see [ADR 0004](./0004-openssh-resolves-the-config-through-ssh-g.md) |
| `sshpk` 1.18.0               | 2023-10-19   | 21.8M            | 10       | Parses keys and certificates; no known_hosts parser; stale                    |
| `known_hosts` 1.0.3          | 2016-03-31   | 10               | 0        | Only `\|1\|` entries, no markers; dead                                        |

ssh2 is the library of docker-modem, so dockerode and Testcontainers for Node.js reach SSH engines with it. deepagents already has it in its lockfile, through dockerode and docker-modem 5.0.7. What it gives, read in its source (`node_modules/ssh2/lib`, version 1.17.0):

- `direct-streamlocal@openssh.com`: `openssh_forwardOutStreamLocal` (`client.js:1533`). `direct-tcpip`: `forwardOut` (`client.js:1398`). Exec, shell and their requests: `exec` (`client.js:1192`), `shell` (`client.js:1249`). Remote listeners: `forwardIn` (`client.js:1333`) and `openssh_forwardInStreamLocal` (`client.js:1457`).
- A transport that the caller gives: the `sock` option (`client.js:290`). A jump host and a ProxyCommand need it.
- Agent auth from a socket path or an agent object (`client.js:219-222`). ssh2 never reads `SSH_AUTH_SOCK` itself.
- A host key callback, `hostVerifier`, with an asynchronous form (`client.js:273-288`).
- Keepalive through `keepaliveInterval` and `keepaliveCountMax` (`client.js:133-140`; `sendKA` at `client.js:716-734`, its `setInterval` at `:740`), and `readyTimeout` (`client.js:141-144`, `:1112-1118`).
- A server: `Server` (`server.js:217`), and `injectSocket` for a transport that the caller accepted (`server.js:361`).
- Its types are `@types/ssh2` 1.15.6 on DefinitelyTyped.

What it does not give:

- No known_hosts, no OpenSSH config, no `AbortSignal`. `privateKey` takes bytes, not a path.
- No `*-cert-v01@openssh.com` host key algorithm, so a host that the known hosts trust only through `@cert-authority` cannot be checked. Its host key algorithms are the plain ones (`protocol/constants.js:65-73`).
- No post-quantum key exchange. Its best key exchange is `curve25519-sha256` (`protocol/constants.js:35-55`). OpenSSH 10.0 made `mlkem768x25519-sha256` its default.
- By default, ssh2 sends the OpenSSH extensions only to a server whose version says OpenSSH (`strictVendor`; for a streamlocal dial, `client.js:1540-1548`). Tailscale SSH announces itself as another server, so a streamlocal dial to it needs `strictVendor: false` (probe `probe-4503/inproc.ts`).
- It has one maintainer. Its last commit was on 2026-08-20, and it has 66 open issues.

Its footprint is 8 packages: `ssh2`, `asn1`, `safer-buffer`, `bcrypt-pbkdf`, `tweetnacl`, and the optional `cpu-features`, `nan` and `buildcheck`. Two of them have install scripts that build native code: `ssh2` builds `sshcrypto.node` with `node-gyp` (`install.js`), and `cpu-features` runs `node-gyp rebuild`. Both are optional at run time. ssh2 loads `sshcrypto.node` in a `try` and falls back to JavaScript (`protocol/crypto.js:30-33`), and it loads `cpu-features` in a `try` (`protocol/constants.js:5-8`).

[docker ADR 0001](../../../docker/docs/adr/0001-the-client-speaks-the-engine-api-not-the-docker-cli.md) rejected dockerode partly for this footprint: "docker-modem brings `ssh2`, and `ssh2` has the native optional dependencies `cpu-features` and `nan`, which an Electron app must package". Ezz does not want native dependencies.

## Decision

Ezz accepted this decision on 2026-11-17, together with [ADR 0004](./0004-openssh-resolves-the-config-through-ssh-g.md) (backlog #4503): "Accept both (Recommended)".

ssh2 speaks the protocol. `@zukhruf/ssh` adds what ssh2 does not give, with the API of Go's `ssh` package.

- `ssh2` is a runtime dependency at its latest release, 1.17.0. `@types/ssh2` is a development dependency. The public types of the package are its own, and no ssh2 type is part of its API.
- The native builds stay off. zukhruf's `.npmrc` sets `strict-allow-scripts=true`, so an install fails when a dependency has an install script that `allowScripts` does not name. The root `allowScripts` does not list `ssh2` and `cpu-features` yet: the first code commit adds `"ssh2": false` and `"cpu-features": false`. The package then runs on ssh2's JavaScript fallback.
- Before the first release, a test run proves the JavaScript fallback: with no `sshcrypto.node` and no `cpu-features` build, the client connects to OpenSSH sshd and to Tailscale SSH, and each cipher that ssh2 offers (AES-GCM, AES-CTR, `chacha20-poly1305@openssh.com` through `protocol/crypto/poly1305.js`) moves data. The run also measures the throughput of a channel against the build with the native binding. The release waits for this measurement, and the README gives its numbers.
- The client sets `strictVendor: false`, so the OpenSSH extensions work with Tailscale SSH.
- The package never passes a host key callback that accepts every key, and it turns `readyTimeout` off (`readyTimeout: 0`, [ADR 0007](./0007-keepalive-and-timeouts-come-only-from-the-resolved-config.md)).

## Considered Options

- **node-ssh or ssh2-promise.** Each wraps ssh2 and adds promises. They add packages and no feature that this package needs. ssh2-promise has no streamlocal.
- **@microsoft/dev-tunnels-ssh.** Its own SSH stack, kept up to date, with no native code. It has no agent client and no streamlocal message, and the docker transport needs streamlocal ([ADR 0002](./0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md)).
- **Write the protocol in this package.** The key exchange, the ciphers and the message parsers become crypto code that we own. ssh2 has 21.2M downloads a week, which find its defects.
- **Start the OpenSSH binary.** [ADR 0002](./0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md) rejects a helper process.
- **ssh2 as the protocol, with the API of Go.** This option was selected.

## Consequences

- An Electron app that depends on `@zukhruf/ssh` packages only JavaScript, when its install also denies the two scripts. npm 12 skips a dependency's install script that `allowScripts` does not name. This answers the concern of docker ADR 0001, once the measurement above holds.
- The package cannot honour `@cert-authority` for host keys until ssh2 offers the certificate host key algorithms. A host that only a `@cert-authority` line trusts fails with `KeyError` ([ADR 0005](./0005-host-keys-are-checked-as-gos-knownhosts-checks-them-under-openssh-stricthostkeychecking.md)). This is a named defect of ssh2 1.17.0, upstream.
- The key exchange is not post-quantum. OpenSSH 10.1 and later warn about this on their own client. A server whose `KexAlgorithms` allows only post-quantum methods refuses the client.
- Identity files of key types that ssh2 cannot parse, such as `sk-ssh-ed25519@openssh.com` and the `id_mldsa44_ed25519` that OpenSSH 10.5 lists, work only through the agent.
- A defect of ssh2 is a defect of this package. The package names the ssh2 version and the issue beside each workaround.
