# Keepalive and timeouts come only from the resolved config

[docker ADR 0010](../../../docker/docs/adr/0010-ssh-gets-the-options-of-the-docker-cli-and-the-flags-of-the-caller.md) decided the keepalive of the docker transport on 2026-11-13, under the maintainer's rule: "follow what the leading tools do, and do not add an opinion of our own". No leading tool sends a keepalive: the Docker CLI, BuildKit, docker-py, docker-modem, the Terraform Docker provider and Ansible. So the package sends no keepalive by default (backlog #4202). A user sets one in `~/.ssh/config`, or the caller gives it in the flags. The Docker CLI sends `-o ConnectTimeout=30`, and so does the docker transport.

`man ssh_config` of OpenSSH 10.5 gives the meaning:

- `ServerAliveInterval`: the "default is 0, indicating that these messages will not be sent". `ServerAliveCountMax` defaults to 3.
- `ConnectTimeout`: the timeout "is applied both to establishing the connection and to performing the initial SSH protocol handshake and key exchange". With no value, the TCP connect waits as long as the system lets it, and the handshake has no limit. The probe of OpenSSH 10.5p1 on 2026-11-17 printed `connecttimeout none` and `serveraliveinterval 0` for a host with no setting.

ssh2 has defaults of its own (`node_modules/ssh2/lib/client.js`, version 1.17.0):

- `readyTimeout` is 20000 ms unless the caller gives a number (`client.js:141-144`). Its timer runs from the start to the end of the authentication, and a value of 0 turns it off (`client.js:1112-1118`).
- `keepaliveInterval` is 0 and `keepaliveCountMax` is 3 (`client.js:133-140`). With an interval, ssh2 sends a `keepalive@openssh.com` global request on a `setInterval` (`client.js:740`; `sendKA` at `client.js:716-734`; `protocol/Protocol.js:350`). After `countMax` requests with no answer, it emits `Keepalive timeout` and destroys the socket.

## Decision

Ezz accepted this decision on 2026-11-17, together with [ADR 0008](./0008-the-environment-and-the-clock-are-inputs.md) (backlog #4503): "Accept both (Recommended)".

The package has no keepalive and no timeout of its own. The connect timeout and the keepalive come only from the client config, and `@zukhruf/ssh/config` fills them only from the resolved config.

- `ClientConfig.connectTimeout`, in milliseconds, is OpenSSH's `ConnectTimeout`. It limits the TCP connect, the banner exchange and the key exchange. It ends when the key exchange ends (ssh2's `handshake` event), so the authentication has no limit, as in OpenSSH. It runs on the clock of the config ([ADR 0008](./0008-the-environment-and-the-clock-are-inputs.md)). When it passes, the dial rejects with a `TimeoutError`, as `timeout` of `@zukhruf/async` gives it. Without a value, no limit applies.
- The package sets `readyTimeout: 0` on ssh2, so ssh2's 20 s limit never applies.
- `ClientConfig.keepalive`, `{ interval, countMax }` in milliseconds and a count, is OpenSSH's `ServerAliveInterval` and `ServerAliveCountMax`. The package gives it to ssh2 as `keepaliveInterval` and `keepaliveCountMax`. Without a value, the client sends no keepalive.
- `@zukhruf/ssh/config` maps `connecttimeout` (seconds, or `none`) and `serveraliveinterval` (seconds, `0` for none) with `serveralivecountmax`. It adds nothing when the config and the flags set nothing.
- After the start, a call has no time limit. The caller gives a signal to each call that waits.

## Considered Options

- **ssh2's defaults.** `readyTimeout` gives every connection a 20 s limit that no user set, and that `ConnectTimeout` does not mean.
- **A keepalive by default**, such as `ServerAliveInterval=10` and `ServerAliveCountMax=2`, the values of `@zukhruf/testing` today. No leading tool sends one (backlog #4202).
- **`ConnectTimeout=30` in the package**, as the Docker CLI sends it. That is a choice of the Docker CLI, so `@zukhruf/docker` keeps it: it adds `-o ConnectTimeout=30` to the flags when the caller's flags do not name `ConnectTimeout` (docker ADR 0010). This package has no Docker CLI to follow.
- **Only the resolved config.** This option was selected.

## Consequences

- Without a keepalive, a connection to a machine that stops answering hangs a call until its signal aborts, as with OpenSSH. Docker ADR 0010 measured this for the old transport: `docker.info()` was still pending after 90 s.
- With a keepalive, ssh2 ends the connection about `interval × (countMax + 1)` after the last answer of the server. Each open channel then ends with an error whose `cause` is the error that ended the connection, and `client.wait()` rejects with it.
- The keepalive timer is ssh2's own `setInterval`, not the clock of the config. [Root ADR 0004](../../../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md) puts a timer inside a third-party package outside our code. A test therefore proves the keepalive on real time, with a short interval and a paused server, and proves the connect timeout on a fake clock.
