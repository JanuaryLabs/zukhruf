# Container engines: research record

This record decides one thing: should Apple's container engine replace Docker Desktop as Ezz's everyday engine on this Mac? Apple's engine is `container` 1.7.1. Our client reaches it through socktainer 1.6.1, a Docker Engine API server on top of it. Ezz, 2026-11-15: "if it is better than docker then I want to use it instead of docker". The verdict is switch or don't switch. If Apple wins on criteria 1 and 2 and is not worse on 3, the record ends with a switch plan. If it loses, the record says by how much and where.

The experiments are in `experiments.yaml`. No experiment has run yet.

## Criteria, in order

1. Wall time of the Docker-backed test suites: packages docker, mutex, then testing's database suites once backlog #4205 lands.
2. Every suite green on Apple's engine, including SQL Server (an amd64 image under Rosetta), leases and the reaper.
3. Idle host memory and container start time.
4. The cost of switching:
   - socktainer is a third-party dependency.
   - Known differences: no pause, network connect is a no-op, whole vCPUs only, and Apple's published-port forwarder drops a connection when the client half-closes.
   - Other repos on this Mac use Docker: text2sql, serverize, deepagents.

## The two engines

Docker Desktop runs one shared Linux VM (8 CPUs, 8 GiB here). Apple's engine boots one small VM per container, and each container has its own IP (192.168.64.x).

```
Docker Desktop                          Apple container 1.7.1
--------------                          ---------------------
client                                  client
  |                                       |
  | unix:///Users/ezzabuzaid/             | unix:///opt/homebrew/var/run/socktainer/
  |   .docker/run/docker.sock             |   .socktainer/container.sock
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

| Rule                | Detail                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same limits         | The same CPU and memory limits on both engines.                                                                                                       |
| Pinned images       | Every image is pinned by digest.                                                                                                                      |
| Cold and warm apart | The first container after an engine update downloads a 66 MB init image (~18 s). socktainer's first create took 17.8 s. Cold runs are reported apart. |
| Interleaving        | Runs go A, B, A, B.                                                                                                                                   |
| Noise floor         | This Mac is shared and noisy. An effect counts only when it is larger than the spread between two runs of the same engine.                            |
| Long runs           | `caffeinate -dimsu`.                                                                                                                                  |
| Micro benchmarks    | hyperfine 2.0.0 with `--warmup 3 --runs 30 --export-json`.                                                                                            |
| Raw output          | Each run's raw output is kept under `docs/research/container-engines/runs/<experiment-id>/`.                                                          |

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

The runs update this table.

| #   | Experiment             | Status   | Verdict |
| --- | ---------------------- | -------- | ------- |
| 1   | startup-alpine-true    | proposed | -       |
| 2   | postgres-time-to-ready | proposed | -       |
| 3   | socktainer-overhead    | proposed | -       |
| 4   | suites-wall-time       | proposed | -       |
| 5   | fio-storage            | proposed | -       |
| 6   | idle-memory            | proposed | -       |
| 7   | attach-round-trip      | proposed | -       |
| 8   | iperf3-network         | proposed | -       |
| 9   | sysbench-cpu           | proposed | -       |
