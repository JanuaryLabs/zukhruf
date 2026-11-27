# A holder on a Docker engine writes a keep-alive byte each 15 seconds, so the engine host ends the connection of a holder that went away

Status: Accepted 2026-11-24 (backlog #5543).

Decision-makers: the zukhruf session mutex-a9 chose the design from the evidence and the top performers. The owner decided two splits. Testing ADR 0020 had accepted the limit of about 2 h for a machine that goes away; for the change of that accepted limit, he said "Approve". For the three holders that have the same limit, he said "All three, as copies": each holder gets its own copy, and the extraction waits for his go.

Three holders in this repository keep a container of a Docker engine with a `cat` whose standard input is the connection of the holder. `cat` ends when its input ends, and the engine closes that input when the connection ends (moby v28.5.2 `daemon/exec.go` l.209-216 and l.291, `CloseStdin: true`; `daemon/attach.go` l.48, `CloseStdin: ctr.Config.StdinOnce`):

- the hold of a reaper: the exec `HOLD` in `packages/testing/src/docker/reaper.ts` ([testing ADR 0020](../../packages/testing/docs/adr/0020-a-reaper-container-removes-a-runs-engine-objects-when-the-attach-that-holds-it-closes-and-recovery-keeps-the-local-records.md));
- `EngineLease` in `packages/testing/src/docker/engine-lease.ts`: the process, sweep and build leases of testing ADR 0014;
- the claim of `DockerEngineStore` in `packages/mutex/src/lock-stores/docker/docker-engine-store.ts` ([mutex ADR 0026](../../packages/mutex/docs/adr/0026-a-docker-engine-key-is-a-named-container-that-lives-while-its-holder-attaches.md)).

On an SSH engine, the connection is a TCP connection between the holder machine and `sshd` on the engine host. When the holder machine goes away with no FIN or RST, only `sshd` and the kernel of the engine host can end that connection. `ClientAliveInterval` of `sshd` is 0 by default, so `sshd` sends no probe (sshd_config.5, OpenSSH V_10_0_P1, l.612-619). TCP keep-alive of Linux ends an idle connection after 7200 + 9 × 75 s, about 2 h 11 min (ip-sysctl.rst, Linux v6.12, l.509-521). A holder sends nothing after its first line, so the connection stays idle, and the hold stays for that time. Backlog #5543 saw this once: after a gate on an overloaded SSH engine (load average 190 on 8 CPUs, SSH banner timeouts), two reapers and their run's objects were still up about 30 min after the gate's processes ended. Each reaper still had a live `cat` for each holder.

The top performers:

- Testcontainers Ryuk 0.14.0 detects a gone client only through the kernel. It reads each client connection until it ends (`reaper.go` l.234-249), and it accepts the connections with Go's default keep-alive (`reaper.go` l.144-146): Go enables keep-alive when `KeepAlive` is zero, with an idle time of 15 s, an interval of 15 s and 9 probes (go1.24.0 `src/net/dial.go` l.17-26 and l.753-761). Its two timeouts, `RYUK_CONNECTION_TIMEOUT` 60 s and `RYUK_RECONNECTION_TIMEOUT` 10 s (`config.go` l.14 and l.18), act only after a disconnect.
- OpenSSH: the side that holds the resource sends a message and waits for the answer: `ClientAliveInterval` on the server (`serverloop.c` l.107-117), `ServerAliveInterval` on the client (ssh_config.5 l.1921-1928).
- Linux: a connection with data that gets no acknowledgement ends after `tcp_retries2` retransmissions: 15 by default, about 924.6 s (ip-sysctl.rst, Linux v6.12, l.697-707).

The rule of all three: the side that holds the resource learns of a silent peer only when it sends something and the kernel gives its verdict. No top performer decides that a peer is dead from a missing message of that peer.

## Decision

After its first line, each of the three holders writes one byte to its output each 15 s while its `cat` runs. The engine sends the byte to the holder through the connection. If the holder machine went away, nothing acknowledges the byte, and the kernel of the engine host ends the connection after its retransmission limit. `sshd` then closes its side, the engine closes the input of `cat`, and the hold ends.

- **The command.** The holder runs `cat 4>&1 > /dev/null | { while :; do timeout -s PIPE 15 head -c 1 > /dev/null; case $? in 124|141) printf . ;; *) break ;; esac; done; }`. `cat` writes its input to `/dev/null`, and its fd 4 holds the pipe to the writer. `head` reads the end of that pipe when `cat` ends, so the writer ends with `cat` and leaves no process. A byte comes only at the status of `timeout` at its limit: 124 from GNU `timeout`, and 141 from BusyBox `timeout`, which gives the status of its program. Any other status, such as 127 for a missing command, stops the writer, and `cat` still holds. The reaper's hold also closes the door's fd 8 in the writer, so only `cat` and its shell hold the lock. The claim of `DockerEngineStore` first runs `command -v cat > /dev/null || exit 127; printf .`: the status of the pipeline is the writer's, so without that check a claim whose image has no `cat` would exit with 0 at once after each start, and the store would try a new claim each time. With it, the claim exits with 127, or writes one ready byte when it finds `cat`. The store waits for the byte or the exit before the mint, and rejects the acquire at 127.
- **The interval is 15 s**: the keep-alive idle time and interval of Go, which Ryuk's connections use. The bound for a holder machine that went away is the interval plus the retransmission limit of the engine host: about 15.7 min with the Linux default. When the machine still runs but its process went away and the FIN was lost, the next byte gets an RST, so the bound is about 15 s. A smaller interval shortens only the second case, and it sends more bytes for each hold.
- **Each holder reads and drops the bytes.** The reaper's hold already reads its output to the end (`drained` in `reaper.ts`). `EngineLease` and the claim did not read the output of their attach. They now read it to the end. Without that read, `@zukhruf/docker` pauses the connection after 64 KiB of unread output, and the SSH channel stops after its window. A failed read ends the lease or loses the claim, as the end of the attach does.
- **A holder that stops reading keeps its hold.** Its kernel still acknowledges each byte. When the pipe is full, the writer waits in `printf`, and `cat` still holds. At 15 s for each byte of 9 bytes on the wire (the byte and its 8-byte frame header), 64 KiB takes about 30 h.

## Considered Options

- **A heartbeat from the holder:** each test process writes to the input of the holder, and the holder ends at a read timeout. A live process whose event loop stops for longer than the bound (synchronous work, a host at load 190, a sleep of the laptop) loses its hold, and the reaper removes the run's objects under it. It decides that a peer is dead from a missing message, as no top performer does.
- **A lease that the holder renews**, with a time stamp in a label or a file. It has the false positive of the heartbeat, and it adds timers and a registry. Testing ADR 0024 and mutex ADR 0012 rejected this shape.
- **`ClientAliveInterval` of `sshd` on each engine host.** It gives about 30 s with `ClientAliveInterval 10` and `ClientAliveCountMax 3`, but the engine host is not ours to set: Tailscale SSH has no such setting. The READMEs give it as advice for the engine hosts that you own.
- **TCP keep-alive or `ServerAliveInterval` on the client.** They tell the client that the server went away. The client already has them (testing `host.ts`, `@zukhruf/ssh` `ServerAliveCheck`). They cannot make the server see a client that went away.
- **A reconnection timeout, as Ryuk has.** It starts only after a disconnect, and here no disconnect comes.

## Consequences

- An SSH engine host ends the hold of a holder machine that went away after about 15 s plus its retransmission limit, instead of about 2 h 11 min. With `TCPKeepAlive no` on the host, the limit was forever.
- A network break of more than the bound now ends the hold of a live holder. The client side already ends its connection sooner: `ServerAliveInterval 10` with `ServerAliveCountMax 2` in testing, so a test process takes a new hold on a new connection. A laptop that sleeps for more than the bound loses its holds and its locks.
- The image of a claim must have `sh`, `cat`, `head` and `timeout`. Before, it needed only `cat`. `node:lts-alpine`, `busybox` and images with coreutils have them; a distroless image does not.
- Each byte also goes to the log of a lease or a claim, whose output is the output of its container: 5,760 bytes a day, with no newline. The engine removes the log with the container. The hold of a reaper is an exec, which has no log.
- The bound of the second case comes from the engine host: its retransmission limit, which we do not set. The bound through Tailscale SSH, whose TCP stack runs in user space, is not measured.
- The three copies are recorded in `packages/testing/docs/copied-code.md`. A fix in one copy goes into each copy. The extraction waits for the owner's go (#5575).

## Confirmation

- The tests, written in #5543 and run in phase B on the local engine: `the reaper over SSH` in `packages/testing/src/docker/reaper.integration.test.ts`, and the test of a holder machine that goes away over SSH in `packages/mutex/src/lock-stores/docker/docker-engine-store.test.ts`. An OpenSSH server in a container (`ClientAliveInterval 0`, `tcp_retries2=5`, so a retransmission limit of about 12.6 s) reaches the engine. The test drops each packet of port 22 in that container, and then kills the holder with SIGKILL. Red before this decision: the hold stays until the time limit of the test. Green: the reaper and the run's objects are gone, or the waiter gets the key. Two controls: a holder killed with no drop ends its hold, and a holder whose event loop is blocked for 20 s, past a keep-alive byte, keeps its hold (60 s until 2026-11-27, #5975).
- The command, run on macOS `sh`, `dash` and `ksh` with GNU `timeout` 9.12: `held`, then one byte each interval, then an exit 30 to 40 ms after the end of the input, with no process left; input bytes do not stop the writer; a reader that stops reading blocks the writer, and `cat` still holds; with no `timeout`, the writer stops and `cat` still holds. The BusyBox status 141 is checked in phase B.
