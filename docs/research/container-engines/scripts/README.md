# Run scripts

One script per experiment in `../experiments.yaml`, named by the experiment id, plus `lib.zsh` (shared parts), `engine-memory.ts` (the memory sampler of experiment 6) and `client-summary.ts` (`summary.tsv` of experiments 2 and 7). The method rules are in `../README.md`.

| #   | Experiment             | Script                                                            |
| --- | ---------------------- | ----------------------------------------------------------------- |
| 1   | startup-alpine-true    | `startup-alpine-true.zsh`                                         |
| 2   | postgres-time-to-ready | `postgres-time-to-ready.zsh` (drives `postgres-time-to-ready.ts`) |
| 3   | socktainer-overhead    | `socktainer-overhead.zsh`                                         |
| 5   | fio-storage            | `fio-storage.zsh`                                                 |
| 6   | idle-memory            | `idle-memory.zsh`                                                 |
| 7   | attach-round-trip      | `attach-round-trip.zsh` (drives `attach-round-trip.ts`)           |
| 8   | iperf3-network         | `iperf3-network.zsh`                                              |
| 9   | sysbench-cpu           | `sysbench-cpu.zsh`                                                |

Experiment 4 runs the nx test targets; its command is below and its script comes later.

## Running

```sh
docs/research/container-engines/scripts/startup-alpine-true.zsh               # both engines, A,B,A,B
docs/research/container-engines/scripts/startup-alpine-true.zsh --interleave 3
docs/research/container-engines/scripts/startup-alpine-true.zsh --engine apple --out /some/folder
docs/research/container-engines/scripts/startup-alpine-true.zsh --dry-run     # prints every command, writes nothing
```

Every script takes the same common options (`--help` lists them and the script's own):

| Option                   | Meaning                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `--engine docker\|apple` | One engine, once.                                                     |
| `--interleave N`         | Both engines, N times each, in the order A,B,A,B. The default, N = 2. |
| `--out DIR`              | Output folder. Default: `runs/<experiment-id>/<UTC timestamp>/`.      |
| `--dry-run`              | Print the commands only.                                              |

Each script:

- re-runs itself under `caffeinate -dimsu`;
- reaches Docker Desktop with `docker -H unix://$HOME/.docker/run/docker.sock` and Apple's engine with `docker -H unix:///opt/homebrew/var/run/socktainer/.socktainer/container.sock` (override with `BENCH_DOCKER_SOCKET` and `BENCH_APPLE_SOCKET`), and Apple's own `container` CLI where the experiment says so;
- wraps every docker and container CLI call in `gtimeout -s KILL` (`BENCH_CALL_TIMEOUT`, default 180 s; the long-running experiments raise it);
- labels every container and volume it makes `dev.zukhruf.bench=1` and, at exit and on Ctrl-C, removes those on the engines of the run (through the docker CLI and, when Apple is in the run, through `container list`/`container delete`), and nothing else; a `--engine docker` run never touches socktainer or Apple's CLI;
- checks every result file after the measurement that writes it: it must be non-empty, and a `.json` file must parse (hyperfine files must hold `.results[i].summary.time_wall_clock.median`); otherwise the experiment fails with `FAILED: ...`, exit 1, and `meta.json` state `failed`. A run that measured nothing never exits 0;
- writes `meta.json` (experiment, state, order, limits, images, the versions of the engines in the run and of the tools, macOS version and host, load average at start and end, other running containers at start, notes, and every command line as run) and `commands.log`.

Run nothing else on either engine while a script runs: another test suite's containers are noise, and `idle-memory.zsh` refuses to start while other containers run.

## Limits

The measured containers get `--cpus 2 --memory 1g` on both engines, except where a script's option changes them (`sysbench-cpu.zsh --cpus`). socktainer floors CPUs to whole vCPUs, so CPU counts stay whole. Apple boots each container in its own VM with the asked vCPUs plus one vCPU of overhead (`configuration.resources.cpuOverhead`); Docker Desktop caps the container with a cgroup quota inside its shared 8-CPU, 8 GiB VM.

## Images

Pinned by the `linux/arm64` manifest digest, so both engines run the same bytes. Both engines pulled each pin on 2026-11-15.

| Image                                 | arm64 digest (the pin)                                                    | Index digest                                                              | Why                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `alpine:3.24.4`                       | `sha256:1829893486be257df5049ab3b7fc95afbd0fc09d89803cbc580bda1ba5386b29` | `sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf` | The Docker official image; latest 3.24 patch.                                                                                                                            |
| `openeuler/fio:3.43-oe2403sp4`        | `sha256:a9be517cbf3c63c500627d68680d2673a98fa8d5c9ed31179da75f0edff8a3ef` | `sha256:7b7d4a5bfdc52accdc667dbe1d37c9c7ca6f313b9472eec6c84d41697d3cc607` | fio 3.43 with libaio and io_uring, multi-arch, updated 2026-10. The common fio images (ljishen/fio, xridge/fio) are amd64 only and from 2019.                            |
| `openeuler/sysbench:1.0.20-oe2403sp4` | `sha256:1950ba366eb34d88e4a4c9b50c90fb55b7467c8da379566b2acdaa597a5bcad7` | `sha256:71ebf9d8564583b2fd47b1952f2fbe9739ad69c2eb3938ea89dc5cc4284516fe` | sysbench 1.0.20, multi-arch. severalnines/sysbench and perconalab/sysbench are amd64 only.                                                                               |
| `networkstatic/iperf3:latest`         | `sha256:069fbed1f741659fb04abc283f21ac22e95d9ef307b14e31225ef7a180bfb2ed` | `sha256:d8767f2888155902ec72760f9ba8dd6fb16ff73256a8e02572c109aecc23269b` | iperf 3.21, multi-arch, entrypoint `iperf3`. It has no version tag, so the pin is the 2026-11-01 `latest`.                                                               |
| `postgres:18-alpine`                  | `sha256:aea692538b8982646f587a0dc0263986ac063c043ab28a43076a07d099a0ef53` | `sha256:b6972e1115a4ff8eba5d7f7d19184926d1e16d7d1136ae1e1a7ebf286da0f015` | PostgreSQL 18.7, the image of `packages/testing`; built 2026-11-12. Read from the registry, not pulled yet: `postgres-time-to-ready.zsh` pulls it before its first slot. |

## Engine-level experiments

| Script                    | What runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Raw output                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `startup-alpine-true.zsh` | `run --rm <alpine> true` with hyperfine `-N --warmup 3 --runs 30`. Arms: docker CLI on Docker Desktop; docker CLI through socktainer; `container run --rm`. Each arm's first run of the session is exported apart, before any warm-up.                                                                                                                                                                                                                                                                                                                                                                     | `first-<arm>.json`, `<slot>-<arm>.json` (hyperfine)                                      |
| `socktainer-overhead.zsh` | hyperfine `--warmup 3 --runs 30` per step (create, start, inspect, rm) with `-N`, and on the whole sequence with `--shell=default`, for the same three arms; Apple's CLI uses `container create/start/inspect/delete --force`. `--prepare` and `--setup` build the state a step needs, so each run times one call. The sequence chains the calls with `&&`, so each of its runs includes one `sh` start; hyperfine 2.0 measures that start apart with its own shell calibration and subtracts it (probe: `hyperfine --shell=default 'true && true'` gives a median of 0.0 µs, `hyperfine -N true` 1.6 ms). | `<slot>-<arm>-<step>.json` (hyperfine)                                                   |
| `fio-storage.zsh`         | One container per slot; `docker exec` runs fio `randwrite` then `randread` at `bs` 4k and 1m, `--size=256M --direct=1 --ioengine=libaio --iodepth=32 --time_based --runtime=20 --ramp_time=2`, on a bind mount of a folder under the user's temporary folder (`getconf DARWIN_USER_TEMP_DIR`, `/var/folders/...`; the path is in `meta.json`), a named volume, and `/var/tmp` on the root filesystem.                                                                                                                                                                                                      | `<slot>-<target>-<rw>-<bs>.json` (fio JSON)                                              |
| `idle-memory.zsh`         | 0, 1, 10, 30 `sleep infinity` alpine containers; at each level 30 s settle, then 3 samples 10 s apart by `engine-memory.ts`: summed RSS of the engine's host processes (Docker: `com.docker.*` and Docker.app processes; Apple: `container-*` processes and socktainer) plus the VM processes, and `footprint` of the same PIDs.                                                                                                                                                                                                                                                                           | `<slot>-level-<n>-sample-<k>.json`                                                       |
| `iperf3-network.zsh`      | An iperf3 server container per slot; `iperf3 -c <ip> -t 10 -J` from a client container (container to container), from the host to `127.0.0.1:<published port>`, and on Apple from the host to the container IP. One discarded 3 s warm-up per path, then 3 runs.                                                                                                                                                                                                                                                                                                                                           | `<slot>-<path>-<n>.json` (iperf3 JSON)                                                   |
| `sysbench-cpu.zsh`        | `sysbench cpu --threads=2 --time=30 run` in a `run --rm` container with `--cpus 2`; one discarded 5 s warm-up per slot, then 3 runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `<slot>-run-<n>.txt` (sysbench has no JSON in 1.0.20), `summary.tsv` (events per second) |

A slot is one engine's turn in the A,B,A,B order: `01-docker`, `02-apple`, `03-docker`, ...

### Traps

- **Two Apple arms, one engine.** socktainer and the `container` CLI reach the same container-apiserver. A container made through socktainer has a Docker-style id there and a UUID in `container list`, so each arm addresses its containers by the name it gave them.
- **VM processes.** Both engines run VMs in `com.apple.Virtualization.VirtualMachine` processes whose parent is launchd. `engine-memory.ts` gives each VM process to the owner that started nearest it (`com.docker.virtualization` or a `container-runtime-linux`), and lists any it cannot place.
- **Docker Desktop's VM RSS moves** with its memory balloon and page cache (1.5 to 4.4 GiB within minutes on 2026-11-15), so read the samples, not one value.
- **Host iperf3.** The host paths of `iperf3-network.zsh` need iperf3 on the macOS host (`brew install iperf3`; iperf 3.22 is installed). Without it the script skips those paths and records that in `meta.json`.
- **A failed iperf3 run** keeps iperf3's error JSON and the script goes on, but it fails unless at least one run on each route measured a throughput (`.end.sum_received.bits_per_second`).
- **Bind mounts from ~/Desktop.** This repo lives under ~/Desktop, which macOS guards with a Files & Folders grant. Docker Desktop has it; Apple's helper does not, and a run with such a bind mount hangs. So `fio-storage.zsh` keeps its bind folder under `/var/folders/...`, which Docker Desktop shares by default.
- **zsh special names.** A local named `path` (or `status`, `options`, ...) replaces the special parameter: `local path=...` empties PATH and every later command fails with exit 127.
- **sysbench threads.** `experiments.yaml` says 4 threads and 4 CPUs; the script defaults to 2 and 2 to match the shared limits. Run `sysbench-cpu.zsh --threads 4 --cpus 4` for the yaml's shape.
- **fio is time-based.** `--size=256M` sets the file size; each job runs for `--runtime` seconds (default 20) after a 2 s ramp, so fast jobs are not over in milliseconds.

## Client-level experiments

Experiments 2 and 7 go through our own client, `@zukhruf/docker`, from `packages/docker` in this repo (with the socktainer fixes of c2adeef3 and d80eb532). Each wrapper takes the common options and runs one `node --conditions=@zukhruf/source <experiment>.ts` per slot; the repo's `node_modules/@zukhruf/docker` link resolves to the package's TypeScript source, which Node runs directly. The `.ts` script connects with `Docker.connect({ clock: globalThis, host })` to the slot's socket, writes `<slot>.json`, and the wrapper ends with `client-summary.ts`, which writes `summary.tsv`: engine, metric, sample (`first` or `warm`), n, failed runs, median, p95 (NumPy's linear quantile, from `@zukhruf/statistics`), min and max, in ms. In a dry run the wrapper runs each `.ts` with `--dry-run`, which prints the exact create body and the plan and touches no engine. Before the first slot, each wrapper pulls its image on an engine that lacks it, and records that in `meta.json`.

Each slot has one first run (it includes any image unpack), stored as `first` in the slot file and summarized apart, then the measured runs.

| Script                       | What runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Raw output                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `postgres-time-to-ready.zsh` | `--runs` (default 10) runs per slot of `postgres:18-alpine` with the Env and `MemorySwappiness: 0` of `packages/testing/src/databases/postgres.ts`, `NanoCpus` 2e9, `Memory` 1 GiB, and 5432 published on `127.0.0.1` with `HostPort: ""`. Each run: create, start, then three loops that poll every 50 ms (cap 60 s): the oracle, `exec pg_isready -h 127.0.0.1 -U postgres -t 1` as `packages/testing` checks; the published port, a TCP connect plus a Postgres SSLRequest that only the server answers (`S` or `N`); on Apple, the same probe on the container IP. `ready_published_ms` and `ready_ip_ms` are the later of the oracle and that path's answer. Then `remove({ force: true, v: true })`. | `<slot>.json` (every run's times, ports, IP, probe attempts), `summary.tsv` |
| `attach-round-trip.zsh`      | `--containers` (default 10) cat leases per slot: alpine, `Entrypoint: ['cat']`, `Cmd: ['-']`, `OpenStdin`, `StdinOnce`, `AttachStdin`, `AutoRemove`, the shared limits. Each: create, `attach({ stdin: true })`, start, `--writes` (default 20) round trips of a 32-byte line from the stdin write to its echo on stdout, close stdin until `exitCode` resolves, then exit until `containers.inspect()` gives 404 (polled every 10 ms) and until `wait({ condition: 'removed' })`, sent before the start, resolves.                                                                                                                                                                                        | `<slot>.json` (every container's times and round trips), `summary.tsv`      |

Metrics in the slot files and `summary.tsv`, in ms:

- postgres-time-to-ready: `create_ms`, `oracle_ms`, `published_tcp_ms`, `published_answer_ms`, `ready_published_ms`, `ip_tcp_ms`, `ip_answer_ms`, `ready_ip_ms` and `total_ms` from t0 (just before the create); `start_ms` from created; `remove_ms` the removal alone.
- attach-round-trip: `create_ms`, `attach_ms`, `start_ms` (each call alone), `round_trip_ms` (all writes pooled), `close_to_exit_ms`, `exit_to_removed_ms` (inspect), `exit_to_removed_wait_ms` (wait).

### Traps

- **Tmpfs.** socktainer ignores `HostConfig.Tmpfs` (backlog #4434) but honours `HostConfig.Mounts` of type `tmpfs`, so `postgres-time-to-ready.ts` puts the data folder (`/var/lib/postgresql`, 512 MiB, mode 01777) on a tmpfs mount on both engines. `packages/testing` still uses `HostConfig.Tmpfs`, so on Apple its Postgres writes to the VM disk.
- **Limits.** `experiments.yaml` names 1 CPU for experiment 2; the script uses the shared `--cpus 2 --memory 1g`.
- **A connect is not readiness.** A port forwarder can accept a TCP connect before Postgres listens, so the `*_tcp_ms` times are recorded but readiness needs the SSLRequest answer. The probe never half-closes the socket: Apple's forwarder drops a half-closed connection.
- **The container IP** comes from the inspect's `NetworkSettings.Networks`. If socktainer gives none, the run records `the inspect gives no IPAddress` and fails, so the slot file shows it at once.
- **wait removed** may not be served by socktainer; `exit_to_removed_wait_ms` is then null and the slot file keeps the error in `waitRemovedError`. `exit_to_removed_ms` does not depend on it.

## Experiment 4 (script comes later)

The package selects the engine from `DOCKER_HOST`, so each command runs once per engine, A,B,A,B, under `caffeinate -dimsu`:

```sh
DOCKER_HOST=unix://$HOME/.docker/run/docker.sock ...
DOCKER_HOST=unix:///opt/homebrew/var/run/socktainer/.socktainer/container.sock ...
```

`/usr/bin/time -p npx nx run docker:test --skip-nx-cache` and `/usr/bin/time -p npx nx run mutex:test --skip-nx-cache` (then testing's database suites once #4205 lands), at least 3 runs per engine. A red suite is recorded with its exit code; it counts against criterion 2.
