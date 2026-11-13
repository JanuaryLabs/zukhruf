# ssh gets the options of the Docker CLI and the flags of the caller

For an `ssh://` host, the connection helper is one `ssh` process for each connection. `sshArguments` in `packages/docker/src/ssh-connection.ts` starts `ssh -T -o BatchMode=yes … docker system dial-stdio`. It sends no connect timeout and no keepalive, and a caller cannot add an option of `ssh`.

Two backlog items asked for a decision:

- **Backlog #4202.** On 2026-11-09 and 2026-11-10, a `docker --context <ssh context> exec` did not return for 14 hours after its command had finished. This was the Docker CLI itself, not this package. The machine of the engine held 84 `docker system dial-stdio` processes with no live client. Its sshd sets no `ClientAliveInterval`.
- **Backlog #3178, gap G4.** A caller needs SSH options for one client.

The maintainer gave the rule for this decision on 2026-11-13: follow what the leading tools do, and do not add an opinion of our own.

This is what the leading tools do, read from their source on 2026-11-13:

| Tool                                                                                                                                                                                    | What it adds to `ssh`                                                                                                               | Keepalive | How the user changes it                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------- |
| Docker CLI ([connhelper.go](https://github.com/docker/cli/blob/master/cli/connhelper/connhelper.go), [ssh/ssh.go](https://github.com/docker/cli/blob/master/cli/connhelper/ssh/ssh.go)) | `-l`, `-p`, the caller's flags, `-o ConnectTimeout=30` (`addSSHTimeout`, only when the flags do not contain `ConnectTimeout`), `-T` | none      | `~/.ssh/config`; a Go caller passes flags to `GetConnectionHelperWithSSHOpts(daemonURL, sshFlags)` |
| BuildKit ([ssh.go](https://github.com/moby/buildkit/blob/master/client/connhelper/ssh/ssh.go))                                                                                          | `-l`, `-p`, `--`                                                                                                                    | none      | `~/.ssh/config`                                                                                    |
| docker-py, ssh binary path ([sshconn.py](https://github.com/docker/docker-py/blob/main/docker/transport/sshconn.py))                                                                    | `-l`, `-p`, `--`                                                                                                                    | none      | `~/.ssh/config`                                                                                    |
| docker-modem, used by dockerode ([ssh.js](https://github.com/apocas/docker-modem/blob/master/lib/ssh.js))                                                                               | nothing of its own; the ssh2 library with the caller's options                                                                      | none      | the caller's options                                                                               |
| Terraform Docker provider ([docs](https://github.com/kreuzwerker/terraform-provider-docker/blob/master/docs/index.md))                                                                  | `ssh_opts`, "Additional SSH option flags to be appended when using `ssh://` protocol"                                               | none      | `ssh_opts`                                                                                         |
| Ansible ssh connection ([docs](https://docs.ansible.com/ansible/latest/collections/ansible/builtin/ssh_connection.html))                                                                | `-C -o ControlMaster=auto -o ControlPersist=60s`, connect timeout 10                                                                | none      | `ssh_args`                                                                                         |

No tool sends a keepalive. The Docker CLI sends a connect timeout, and it takes flags from its caller. The documentation of Docker puts SSH settings in `~/.ssh/config` ([Protect the Docker daemon socket, SSH tips](https://docs.docker.com/engine/security/protect-access/)).

`man ssh_config` of OpenSSH 10.5 gives the meaning of the options:

- `ServerAliveInterval`: the "default is 0, indicating that these messages will not be sent".
- `ConnectTimeout`: the timeout "is applied both to establishing the connection and to performing the initial SSH protocol handshake and key exchange".
- Options on the command line come before `~/.ssh/config`, and for each option "the first specified value will be used".

A probe on OpenSSH 10.5p1 on 2026-11-13 showed the last rule on one command line. `ssh -G` prints the resolved settings and makes no connection:

- `-o BatchMode=no -o BatchMode=yes` resolved to `batchmode no`.
- `-o ConnectTimeout=5 -o ConnectTimeout=30` resolved to `connecttimeout 5`.

## Considered Options

- **A keepalive default on the command line**: `-o ServerAliveInterval=10 -o ServerAliveCountMax=2`, the values that `@zukhruf/testing` sends for its SSH forwards. An option on the command line replaces the value in the user's `~/.ssh/config`, and no leading tool sends a keepalive.
- **A defaults file that the package passes with `-F`.** The file includes `~/.ssh/config` and `/etc/ssh/ssh_config`, and then sets the values under `Host *`. A probe with `ssh -G` showed that it works: a host that the user configured kept the user's values, another host got the defaults, and the other resolved settings were equal to the settings of plain `ssh`. But no leading tool does this, `-F` makes `ssh` skip the system file, and the file is not proved on Windows.
- **No flags from the caller.** The leading tools take flags. [ADR 0003](./0003-the-package-leads-and-the-repositories-change.md) says that a capability "is never out because no consumer uses it yet".
- **The options of the Docker CLI, and the flags of the caller.** This option was selected.

## Consequences

- The package sends `-o ConnectTimeout=30` for an `ssh://` engine, as the Docker CLI does. It does not send it when the caller's flags name `ConnectTimeout`.
- The package sends no keepalive (`ServerAliveInterval`, `ServerAliveCountMax`) by default. A user sets a keepalive in `~/.ssh/config`, or the caller gives it in `sshFlags`.
- `ConnectOptions` gets `sshFlags?: readonly string[]`: raw flags for `ssh`. The name is the name of the parameter of the Docker CLI. Only an engine at an `ssh://` host uses the flags. That includes an `ssh://` host that a context or `DOCKER_HOST` selected.

  ```ts
  await Docker.connect({
    clock: globalThis,
    host: 'ssh://root@box',
    sshFlags: ['-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2'],
  });
  ```

- The caller's flags come first on the command line. OpenSSH uses the first value that it gets for each option, so the caller's flags win over the options of the package.
- `-o BatchMode=yes` stays as it is. It is an option of the package: the Docker CLI does not send it. No reason for it is recorded. The commit that added it to the design (`f3c8c48d`), the commit that added it to the code (`8250b880`), the README and the ADRs name the option and give no reason. This ADR does not change the option.
- A dead connection still hangs a call, as it hangs the Docker CLI. The call ends only when the user set a keepalive in `~/.ssh/config`, when the caller gave one in `sshFlags`, or when the call has a signal.
- With a keepalive, `ssh` exits with 255 when the machine stops answering. A call that waits for its answer rejects with `ConnectionFailedError`. An open stream gets the exit error of `ssh`.
- With connection sharing (`ControlMaster`), the settings of the master connection apply. The flags of a later `ssh` do not.
- The machine of the engine keeps the `docker system dial-stdio` of a client that vanished until its own sshd ends the connection (`ClientAliveInterval`). That is a setting of that machine, outside the package.
- [ADR 0001](./0001-the-client-speaks-the-engine-api-not-the-docker-cli.md) says that the package has no timeout of its own. That still holds for a call: no call has a time limit. The connect timeout is the timeout of `ssh`, as the Docker CLI sends it.
- A measurement on a real sshd is pending: a container that is paused in the middle of a call, with and without the keepalive flags.
