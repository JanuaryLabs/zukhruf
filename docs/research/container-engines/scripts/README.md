# Run scripts

One script per engine-level experiment in `../experiments.yaml`, named by the experiment id, plus `lib.zsh` (shared parts) and `engine-memory.ts` (the memory sampler of experiment 6). The method rules are in `../README.md`.

| #   | Experiment          | Script                    |
| --- | ------------------- | ------------------------- |
| 1   | startup-alpine-true | `startup-alpine-true.zsh` |
| 3   | socktainer-overhead | `socktainer-overhead.zsh` |
| 5   | fio-storage         | `fio-storage.zsh`         |
| 6   | idle-memory         | `idle-memory.zsh`         |
| 8   | iperf3-network      | `iperf3-network.zsh`      |
| 9   | sysbench-cpu        | `sysbench-cpu.zsh`        |

Experiments 2, 4 and 7 use `@zukhruf/docker` or the nx test targets; their commands are below and their scripts come after the client fixes of backlog #4430.

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
- labels every container and volume it makes `dev.zukhruf.bench=1` and, at exit and on Ctrl-C, removes those on both engines (through the docker CLI and through `container list`/`container delete`), and nothing else;
- writes `meta.json` (experiment, state, order, limits, images, engine and tool versions, macOS version and host, load average at start and end, other running containers at start, notes, and every command line as run) and `commands.log`.

Run nothing else on either engine while a script runs: another test suite's containers are noise, and `idle-memory.zsh` refuses to start while other containers run.

## Limits

The measured containers get `--cpus 2 --memory 1g` on both engines, except where a script's option changes them (`sysbench-cpu.zsh --cpus`). socktainer floors CPUs to whole vCPUs, so CPU counts stay whole. Apple boots each container in its own VM with the asked vCPUs plus one vCPU of overhead (`configuration.resources.cpuOverhead`); Docker Desktop caps the container with a cgroup quota inside its shared 8-CPU, 8 GiB VM.

## Images

Pinned by the `linux/arm64` manifest digest, so both engines run the same bytes. Both engines pulled each pin on 2026-11-15.

| Image                                 | arm64 digest (the pin)                                                    | Index digest                                                              | Why                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `alpine:3.24.4`                       | `sha256:1829893486be257df5049ab3b7fc95afbd0fc09d89803cbc580bda1ba5386b29` | `sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf` | The Docker official image; latest 3.24 patch.                                                                                                 |
| `openeuler/fio:3.43-oe2403sp4`        | `sha256:a9be517cbf3c63c500627d68680d2673a98fa8d5c9ed31179da75f0edff8a3ef` | `sha256:7b7d4a5bfdc52accdc667dbe1d37c9c7ca6f313b9472eec6c84d41697d3cc607` | fio 3.43 with libaio and io_uring, multi-arch, updated 2026-10. The common fio images (ljishen/fio, xridge/fio) are amd64 only and from 2019. |
| `openeuler/sysbench:1.0.20-oe2403sp4` | `sha256:1950ba366eb34d88e4a4c9b50c90fb55b7467c8da379566b2acdaa597a5bcad7` | `sha256:71ebf9d8564583b2fd47b1952f2fbe9739ad69c2eb3938ea89dc5cc4284516fe` | sysbench 1.0.20, multi-arch. severalnines/sysbench and perconalab/sysbench are amd64 only.                                                    |
| `networkstatic/iperf3:latest`         | `sha256:069fbed1f741659fb04abc283f21ac22e95d9ef307b14e31225ef7a180bfb2ed` | `sha256:d8767f2888155902ec72760f9ba8dd6fb16ff73256a8e02572c109aecc23269b` | iperf 3.21, multi-arch, entrypoint `iperf3`. It has no version tag, so the pin is the 2026-11-01 `latest`.                                    |

## Engine-level experiments

| Script                    | What runs                                                                                                                                                                                                                                                                                                                        | Raw output                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `startup-alpine-true.zsh` | `run --rm <alpine> true` with hyperfine `-N --warmup 3 --runs 30`. Arms: docker CLI on Docker Desktop; docker CLI through socktainer; `container run --rm`. Each arm's first run of the session is exported apart, before any warm-up.                                                                                           | `first-<arm>.json`, `<slot>-<arm>.json` (hyperfine)                                      |
| `socktainer-overhead.zsh` | hyperfine `--warmup 3 --runs 30` per step (create, start, inspect, rm) and on the whole sequence, for the same three arms; Apple's CLI uses `container create/start/inspect/delete --force`. `--prepare` and `--setup` build the state a step needs, so each run times one call.                                                 | `<slot>-<arm>-<step>.json` (hyperfine)                                                   |
| `fio-storage.zsh`         | One container per slot; `docker exec` runs fio `randwrite` then `randread` at `bs` 4k and 1m, `--size=256M --direct=1 --ioengine=libaio --iodepth=32 --time_based --runtime=20 --ramp_time=2`, on a bind mount of a folder under the run folder, a named volume, and `/var/tmp` on the root filesystem.                          | `<slot>-<target>-<rw>-<bs>.json` (fio JSON)                                              |
| `idle-memory.zsh`         | 0, 1, 10, 30 `sleep infinity` alpine containers; at each level 30 s settle, then 3 samples 10 s apart by `engine-memory.ts`: summed RSS of the engine's host processes (Docker: `com.docker.*` and Docker.app processes; Apple: `container-*` processes and socktainer) plus the VM processes, and `footprint` of the same PIDs. | `<slot>-level-<n>-sample-<k>.json`                                                       |
| `iperf3-network.zsh`      | An iperf3 server container per slot; `iperf3 -c <ip> -t 10 -J` from a client container (container to container), from the host to `127.0.0.1:<published port>`, and on Apple from the host to the container IP. One discarded 3 s warm-up per path, then 3 runs.                                                                 | `<slot>-<path>-<n>.json` (iperf3 JSON)                                                   |
| `sysbench-cpu.zsh`        | `sysbench cpu --threads=2 --time=30 run` in a `run --rm` container with `--cpus 2`; one discarded 5 s warm-up per slot, then 3 runs.                                                                                                                                                                                             | `<slot>-run-<n>.txt` (sysbench has no JSON in 1.0.20), `summary.tsv` (events per second) |

A slot is one engine's turn in the A,B,A,B order: `01-docker`, `02-apple`, `03-docker`, ...

### Traps

- **Two Apple arms, one engine.** socktainer and the `container` CLI reach the same container-apiserver. A container made through socktainer has a Docker-style id there and a UUID in `container list`, so each arm addresses its containers by the name it gave them.
- **VM processes.** Both engines run VMs in `com.apple.Virtualization.VirtualMachine` processes whose parent is launchd. `engine-memory.ts` gives each VM process to the owner that started nearest it (`com.docker.virtualization` or a `container-runtime-linux`), and lists any it cannot place.
- **Docker Desktop's VM RSS moves** with its memory balloon and page cache (1.5 to 4.4 GiB within minutes on 2026-11-15), so read the samples, not one value.
- **Host iperf3.** The host paths of `iperf3-network.zsh` need iperf3 on the macOS host (`brew install iperf3`). It is not installed now; the script skips those paths and records that in `meta.json`.
- **sysbench threads.** `experiments.yaml` says 4 threads and 4 CPUs; the script defaults to 2 and 2 to match the shared limits. Run `sysbench-cpu.zsh --threads 4 --cpus 4` for the yaml's shape.
- **fio is time-based.** `--size=256M` sets the file size; each job runs for `--runtime` seconds (default 20) after a 2 s ramp, so fast jobs are not over in milliseconds.

## Client-level experiments (scripts come later)

These need the `@zukhruf/docker` fixes of backlog #4430. The package selects the engine from `DOCKER_HOST`, so each command runs once per engine, A,B,A,B, under `caffeinate -dimsu`:

```sh
DOCKER_HOST=unix://$HOME/.docker/run/docker.sock ...
DOCKER_HOST=unix:///opt/homebrew/var/run/socktainer/.socktainer/container.sock ...
```

| #   | Experiment             | Command it will run                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2   | postgres-time-to-ready | `node postgres-time-to-ready.ts --engine docker\|apple`: creates `postgres:18-alpine` (pinned by digest) through `@zukhruf/docker` with the Env, tmpfs data folder and limits (1 CPU, 1 GiB) of `packages/testing/src/databases/postgres.ts`, and times create until `pg_isready` answers, 3 warm-ups and 30 runs. On Apple twice: on the published `127.0.0.1` port and on the container IP. |
| 4   | suites-wall-time       | `/usr/bin/time -p npx nx run docker:test --skip-nx-cache` and `/usr/bin/time -p npx nx run mutex:test --skip-nx-cache` (then testing's database suites once #4205 lands), at least 3 runs per engine. A red suite is recorded with its exit code; it counts against criterion 2.                                                                                                              |
| 7   | attach-round-trip      | `node attach-round-trip.ts --engine docker\|apple`: a `cat` lease (`Cmd: ['-']`) attached before start, as in `packages/testing` and the mutex store; times a stdin write to its echo on stdout, and stdin close to container exit, 3 warm-ups and 30 runs.                                                                                                                                   |
