# Host keys are checked as Go's knownhosts checks them, under OpenSSH's StrictHostKeyChecking

The host key proves that the client talks to the right server, before it sends a credential (RFC 4253 §8). OpenSSH checked it for the docker transport, against the known hosts files, with `BatchMode=yes`: an unknown or changed key failed, and no prompt came ([docker ADR 0010](../../../docker/docs/adr/0010-ssh-gets-the-options-of-the-docker-cli-and-the-flags-of-the-caller.md)). ssh2 gives only a callback, `hostVerifier`, and reads no file ([ADR 0003](./0003-ssh2-speaks-the-protocol.md)). npm has no parser that knows the whole format: `known_hosts` 1.0.3 reads only `|1|` entries and no markers, and `sshpk` has no known_hosts parser (research `~/.claude/plans/zukhruf-ssh-4503-research.md`, step 1).

The format is in sshd(8), section SSH_KNOWN_HOSTS FILE FORMAT. A line has host patterns (`*`, `?`, and `!` to negate), or a hashed name (`|1|<salt>|<HMAC-SHA1>`), and a key. A name with a port other than 22 is written `[host]:port`. A line can start with `@revoked` or `@cert-authority`.

Go's `ssh/knownhosts` reads that format (research, step 2). `knownhosts.New(files...)` gives a `HostKeyCallback`. An unknown key gives `*KeyError` with an empty `Want`. A changed key gives `*KeyError` whose `Want` lists the known keys. A revoked key gives `*RevokedError`. Go offers its host key algorithms in a fixed order, so a server can answer with an RSA key while the known hosts hold its Ed25519 key, and the check fails (golang/go#29286). Podman's `containers/common/pkg/ssh` uses skeema/knownhosts, which puts the algorithms of the known keys first. OpenSSH does the same (`order_hostkeyalgs` in `sshconnect2.c`).

OpenSSH's `StrictHostKeyChecking` decides what happens to an unknown, a changed or a revoked key. ssh_config(5): with `accept-new`, ssh "will automatically add new host keys to the user's known_hosts file, but will not permit connections to hosts with changed host keys". With `no` or `off`, ssh "will automatically add new host keys to the user known hosts files and allow connections to hosts with changed hostkeys to proceed, subject to some restrictions". The default is `ask`. With `BatchMode=yes`, `ask` cannot prompt, so OpenSSH fails as with `yes`. The probe of OpenSSH 10.5p1 on 2026-11-17 printed `stricthostkeychecking ask` for a host with no setting. A revoked key fails under each value but `no`. Under `no`, OpenSSH connects with the restrictions of a changed key (`check_host_key` in `sshconnect.c`, lines 1289-1307: `goto continue_unsafe`).

## Decision

Ezz accepted this decision on 2026-11-17 (backlog #4503): "Accept (Recommended)". For a revoked key under `no`, he chose on the same day: "Follow OpenSSH (Recommended)".

`KnownHosts` of `@zukhruf/ssh/knownhosts` checks a host key as Go's `knownhosts` does. `@zukhruf/ssh/config` applies the resolved `StrictHostKeyChecking` around it, and never prompts.

- `KnownHosts.read(files)` reads the files in order. A missing file is empty, as for OpenSSH. `@zukhruf/ssh/config` gives the user files first, then the global files.
- `check(hostname, port, key)` looks up `hostname`, or `[hostname]:port` when the port is not 22, as Go's `knownhosts.Normalize` writes it. `@zukhruf/ssh/config` gives the `HostKeyAlias` in place of the hostname when one is set.
- It matches plain names, patterns with `*`, `?` and `!`, and hashed names. A match on an `@revoked` line throws `RevokedError`. No known key for the name throws `KeyError` with an empty `want`. Known keys that are all different from the key throw `KeyError` whose `want` lists them, each with its file and line.
- It reads `@cert-authority` lines and uses none of them. ssh2 offers no certificate host key algorithm ([ADR 0003](./0003-ssh2-speaks-the-protocol.md)), so the server never sends a certificate. A host that only a `@cert-authority` line trusts fails with `KeyError` and an empty `want`.
- `hostKeyAlgorithms(hostname, port, offered)` puts the algorithms of the known keys first, as OpenSSH does.
- `add(hostname, port, key, { hash })` appends a line to the first file, hashed when `hash` is true (OpenSSH's `HashKnownHosts`). It makes the file when it is missing.
- `@zukhruf/ssh/config` applies the host key policy. `ssh -G` prints `true`, `false`, `ask` or `accept-new` (`multistate_strict_hostkey` in OpenSSH's `readconf.c`): `yes` prints as `true`, and `no` and its other spelling `off` print as `false`. `OpenSshConfig#strictHostKeyChecking` gives them as `'yes'`, `'no'`, `'ask'` and `'accept-new'`:

  | `strictHostKeyChecking` | `ssh -G` prints | Unknown key                                       | Changed key                             | Revoked key                           |
  | ----------------------- | --------------- | ------------------------------------------------- | --------------------------------------- | ------------------------------------- |
  | `'yes'`                 | `true`          | `KeyError`, `want` empty                          | `KeyError`, `want` lists the known keys | `RevokedError`                        |
  | `'ask'` (the default)   | `ask`           | As `'yes'`: the client never prompts              | As `'yes'`                              | `RevokedError`                        |
  | `'accept-new'`          | `accept-new`    | Adds the key to the first user file, and connects | `KeyError`                              | `RevokedError`                        |
  | `'no'`                  | `false`         | Adds the key to the first user file, and connects | Connects, with the restrictions below   | Connects, with the restrictions below |

- The restrictions for `'no'` follow OpenSSH. After a changed or a revoked key, `check_host_key` in `sshconnect.c` (lines 1365-1416 of OpenSSH 10.5p1) turns off password and keyboard-interactive auth, agent forwarding, X11 forwarding, each `LocalForward` and `RemoteForward` (`-L`, `-R`) and tunnels. It does not turn off `-W`, the stdio forward that `ProxyJump` uses. So under `'no'` with a changed or a revoked key:
  - the client connects, and sessions run;
  - `client.dial` works, as `-W` does, so a chain of jump hosts goes on;
  - `client.listen` rejects with `KeyError`, as OpenSSH cancels `-R`;
  - agent forwarding is off: no session asks for it;
  - the client offers no password and no keyboard-interactive auth.
- The root import path has no policy and no default. `ClientConfig.hostKey` is required, as Go's `HostKeyCallback` is.

## Considered Options

- **A pinned fingerprint** (ssh2's `hostHash` and `hostVerifier`). Each caller then keeps its own list, and the user's known hosts do not apply.
- **Trust on first use, always.** It ignores the user's `StrictHostKeyChecking`, and a changed key would connect.
- **A changed key fails under every setting.** It is safer than `no`, but it is an opinion of our own. The leaders' rule is to follow the tool (docker ADR 0010: "follow what the leading tools do, and do not add an opinion of our own").
- **Go's `knownhosts`, under OpenSSH's policy.** This option was selected.

## Consequences

- A key that the user trusts for `ssh` in a terminal is trusted by the package, and a key that `ssh` refuses in batch mode is refused.
- `KeyError` and `RevokedError` are two classes, as in Go, because the caller's next step differs. After `KeyError`, a person can add the key or report a possible attack. After `RevokedError`, only `StrictHostKeyChecking no` connects, and only in the restricted mode.
- Two processes that add a key at the same time can append two lines. OpenSSH appends with no lock too. Two equal lines do no harm.
- `@cert-authority` waits for ssh2. When ssh2 offers the certificate host key algorithms, `check` takes the certificate and its authority, as Go's `knownhosts` does with `IsHostAuthority`.
