# Container engines: research record

This record decides one thing: should Apple's container engine replace Docker Desktop as Ezz's everyday engine on this Mac? Apple's engine is `container` 1.7.1. Our client reaches it through socktainer 1.6.1, a Docker Engine API server on top of it. Ezz, 2026-11-15: "if it is better than docker then I want to use it instead of docker". The verdict is switch or don't switch. If Apple wins on criteria 1 and 2 and is not worse on 3, the record ends with a switch plan. If it loses, the record says by how much and where.

Ezz widened the field on 2026-11-16: Colima, OrbStack and Docker Desktop on its Docker VMM hypervisor are measured too, and the Apple arm waits for a socktainer release built for container 1.7.1. The question becomes which engine beats Docker Desktop on VZ, today's engine, on the criteria below.

The experiments are in `experiments.yaml`. A first batch ran on 2026-11-15 and is invalid (its attempts in `experiments.yaml` say why). Pass 2, on 2026-11-16, measured Docker Desktop on VZ against Colima; its results are in [`results/2026-11-16-docker-vs-colima.md`](results/2026-11-16-docker-vs-colima.md).

## Criteria, in order

1. Wall time of the Docker-backed test suites: packages docker, mutex, then testing's database suites once backlog #4205 lands.
2. Every suite green on the candidate engine, including SQL Server (an amd64 image under Rosetta), leases and the reaper.
3. Idle host memory and container start time.
4. The cost of switching:
   - socktainer is a third-party dependency.
   - Known differences: no pause, network connect is a no-op, whole vCPUs only, and Apple's published-port forwarder drops a connection when the client half-closes.
   - Other repos on this Mac use Docker: text2sql, serverize, deepagents.
   - Apple's helper needs a macOS Files & Folders grant to bind-mount from ~/Desktop, where this repo lives; Docker Desktop already has it. Without the grant, a run with such a bind mount hangs (sandboxd logs `kTCCServiceSystemPolicyDesktopFolder` denied).

## Engines in scope

The scripts address each engine by its Docker Engine API socket; `scripts/README.md` holds the engine table (socket, docker context, memory attribution, arms).

| Engine                     | Script name  | State on 2026-11-16                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Docker Desktop on VZ       | `docker`     | Today's engine and the baseline: one shared Linux VM (8 CPUs, 8 GiB) on Apple's Virtualization framework.                                                                                                                                                                                                                                                                            |
| Docker Desktop, Docker VMM | `docker-vmm` | The same socket while Docker Desktop runs on its Docker VMM hypervisor (libkrun); a manual setting switch, checked by each script.                                                                                                                                                                                                                                                   |
| Colima                     | `colima`     | 0.10.3 running: Docker 29.5.2 in one Lima VM on VZ, virtiofs, Rosetta, 8 CPUs, 8 GiB; pass 2 ran on Lima's ssh port forwarder, as the grpc one loses backpressure.                                                                                                                                                                                                                   |
| OrbStack                   | `orbstack`   | 2.2.x, 8 CPU / 8 GiB like Docker Desktop and Colima; context `orbstack` created by hand, `docker.set_context: false`. Switch facts: published ports are exposed to the LAN by default (`docker.expose_ports_to_lan: true`); it sets the docker context on start unless `docker.set_context` is false (it took the current context once during setup on 2026-11-16 and was restored). |
| Apple `container` 1.7.1    | `apple`      | Paused until socktainer ships a release built for container 1.7.1; one small VM per container, each with its own IP (192.168.64.x).                                                                                                                                                                                                                                                  |

Considered and not testable: **Kiri**. Its only trace is a flagged Show HN post (news.ycombinator.com item 50353261), and no repository was found. As described it is an OCI runtime, the runc layer inside a Linux VM, not an engine that runs containers on a Mac.

```
Docker Desktop, Colima, OrbStack        Apple container 1.7.1
--------------------------------        ---------------------
client                                  client
  |                                       |
  | unix://<engine socket>                | unix:///opt/homebrew/var/run/socktainer/
  |                                       |   .socktainer/container.sock
  v                                       v
+---------------------------+           socktainer 1.6.1 (Engine API)
| one Linux VM (8 CPU, 8GiB)|             |
|  +-----+ +-----+ +-----+  |             v
|  | c1  | | c2  | | c3  |  |           container apiserver
|  +-----+ +-----+ +-----+  |             |
+---------------------------+      +------+------+------+
                                   v             v      v
                                +------+     +------+ +------+
                                | VM c1|     | VM c2| | VM c3|
                                | .64.2|     | .64.3| | .64.4|
                                +------+     +------+ +------+
```

socktainer runs with `HOME=/opt/homebrew/var/run/socktainer`.

## Method rules

| Rule                | Detail                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Same limits         | The same CPU and memory limits on every engine.                                                                                                        |
| Pinned images       | Every image is pinned by digest.                                                                                                                       |
| Cold and warm apart | The first container after an engine update downloads a 66 MB init image (~18 s). socktainer's first create took 17.8 s. Cold runs are reported apart.  |
| Interleaving        | Runs go A, B, C, A, B, C over the engines of a run.                                                                                                    |
| Noise floor         | This Mac is shared and noisy. An effect counts only when it is larger than the spread between two runs of the same engine.                             |
| Long runs           | `caffeinate -dimsu`.                                                                                                                                   |
| Micro benchmarks    | hyperfine 2.0.0 with `--warmup 3 --runs 30 --export-json`.                                                                                             |
| hyperfine 2.0 JSON  | Timings, in seconds, are at `.results[i].summary.time_wall_clock.{median,mean,min,max,stddev,count}`, not at `.results[i].median` as in hyperfine 1.x. |
| vCPUs on Apple      | Apple gives N+1 vCPUs for `--cpus N`: `container run --cpus 1` shows `nproc` 2; through socktainer, NanoCpus 1e9, 2e9 and 3e9 give 2, 3 and 4.         |
| Result checks       | Every result file must be non-empty, and JSON must parse; a run that measured nothing fails its experiment.                                            |
| Raw output          | Each run's raw output is kept under `docs/research/container-engines/runs/<experiment-id>/`.                                                           |

## Prior art

All of it tested versions older than 1.7.1. None measured 1.7.x.

| Source                                                                                                                       | Version                  | Findings (Apple vs other)                                                                                                                           | Limits                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [zot24/macos-container-benchmarks](https://github.com/zot24/macos-container-benchmarks)                                      | container 0.11.0, M3     | `run --rm alpine echo` 0.935 s vs 0.329 s (Docker); iperf3 container to container 23.0 vs 119.1 Gbps; dd bind-mount write 1280 vs 1327 MB/s         | Times python startup; dd from /dev/zero; 12 samples |
| [Jmeg8r/apple-container-vs-docker](https://github.com/Jmeg8r/apple-container-vs-docker)                                      | container 1.0.0          | Start to exit 876 ms vs 272 ms; fio 4k random write on a bind mount 37.7 vs 770 MB/s (OrbStack); idle helper RAM 154 MB vs 1115 MB (Docker Desktop) | Good controls, but one published run                |
| [apple/container #882](https://github.com/apple/container/issues/882), [#948](https://github.com/apple/container/issues/948) | before PR #1041          | fio on the root filesystem 666 MB/s vs 10.8 GB/s; brought in line by [PR #1041](https://github.com/apple/container/pull/1041) (closed 2026-01-17)   | The maintainer notes high variance                  |
| RepoFlow blog                                                                                                                | container 0.6.0, M4 mini | sysbench and fio, 20 runs                                                                                                                           | Numbers only in charts; no scripts                  |

## Smoke observations (2026-11-15)

Not a result: uncontrolled. `run --rm alpine true`, warm, 4 to 8 runs each.

| Engine                  | Range       |
| ----------------------- | ----------- |
| Apple (Apple's package) | 0.73-0.85 s |
| Apple (Homebrew build)  | 0.80-0.99 s |
| Docker Desktop          | 0.16-0.19 s |

## Status

Pass 2 (2026-11-16, HEAD 961a7733) measured Docker Desktop on VZ against Colima, with no quiet gate and with other sessions on Docker Desktop. Results, tables and caveats: [`results/2026-11-16-docker-vs-colima.md`](results/2026-11-16-docker-vs-colima.md). So far Colima wins the testing suite by 10%, ties on docker and uses about 730 MiB less memory; its mutex gap and its one red mutex test are a test-fixture defect (the run's reaper held on Docker Desktop, #4205), not the engine, so mutex is re-measured after the fixture fix.

Apple-side measurements are paused until a socktainer release built for container 1.7.1 (Ezz, 2026-11-16); socktainer 1.6.1 is built for container 1.6.1 and warns of the mismatch at start. Docker VMM waits for the switch.

The runs update this table. A verdict compares Colima with Docker Desktop on VZ; a difference counts only when it is larger than the A-to-A spread.

| #   | Experiment             | Status | Verdict       |
| --- | ---------------------- | ------ | ------------- |
| 1   | startup-alpine-true    | done   | no-difference |
| 2   | postgres-time-to-ready | done   | no-difference |
| 3   | socktainer-overhead    | done   | docker-faster |
| 4   | suites-wall-time       | done   | mixed         |
| 5   | fio-storage            | done   | docker-faster |
| 6   | idle-memory            | done   | colima-faster |
| 7   | attach-round-trip      | done   | docker-faster |
| 8   | iperf3-network         | done   | colima-faster |
| 9   | sysbench-cpu           | done   | no-difference |
