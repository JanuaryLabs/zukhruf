# Pass 2, 2026-11-16: Docker Desktop on VZ against Colima

The first measured pass of every experiment, on two engines. It ran from 07:14 to 08:49 UTC at HEAD 961a7733, interleaved docker, colima.

| Engine         | Setup                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Docker Desktop | VZ hypervisor, 8 CPUs, 8 GiB, Docker 29.8.0                                                                             |
| Colima 0.10.3  | VZ, virtiofs, Rosetta, 8 CPUs, 8 GiB, Docker 29.5.2, Lima's ssh port forwarder (the grpc one loses backpressure, below) |

Raw output: `runs/<experiment>/<UTC>/`, folders named in each table.

## Conditions

- **No quiet gate.** Ezz: "no gate needed". The 1-minute load average went from 3.8 to 62.1; it peaked at the start of fio-storage.
- **A bias against Docker Desktop.** Other sessions used Docker Desktop during the pass, with their shared database servers and their tests. Only this pass used Colima. `meta.json` saw no foreign container at any experiment's start, but the suites saw up to 3 other `node --test` processes. The one exception: 5 containers left on Colima by the suites at the start of startup-alpine-true.
- **Warm-up.** The suites ran with `--no-warmup`. The warm-up runs of pass 1 (`runs/suites-wall-time/20261116T063919Z`, not measurements) had already pulled the images and created the shared servers on both engines.
- **Colima's port forwarder.** Lima's gRPC forwarder loses backpressure on the forwarded Docker socket: a stalled reader still let the writer finish 1000 blocks, against 93 on Docker Desktop. So Colima ran with the ssh forwarder, which keeps backpressure but has a known cap of about 1000 concurrent connections on published ports.
- **Spread.** A-to-A spread is the gap between one engine's rounds: the two round medians, or for the suites the range of the three runs. A difference counts as real only when it is larger than the bigger of the two engines' spreads.

## Criterion 1: suite wall time

`runs/suites-wall-time/20261116T071419Z`, 3 runs per engine and suite, in seconds.

| Suite   | Docker median (min to max) | Colima median (min to max) | Spread (Docker / Colima) | Colima minus Docker | Real?                                       |
| ------- | -------------------------- | -------------------------- | ------------------------ | ------------------- | ------------------------------------------- |
| docker  | 19.8 (19.3 to 20.1)        | 25.6 (19.3 to 28.6)        | 0.8 / 9.3                | +5.7 (+29%)         | no                                          |
| mutex   | 98.2 (95.1 to 126.6)       | 148.5 (148.0 to 148.6)     | 31.5 / 0.5               | +50.3 (+51%)        | no: a test-fixture defect adds a 120 s wait |
| testing | 295.9 (282.0 to 303.9)     | 265.5 (253.3 to 265.8)     | 21.9 / 12.6              | -30.4 (-10%)        | yes: every Colima run beat every Docker run |
| total   | 413.9                      | 439.6                      |                          | +25.7 (+6%)         |                                             |

Every Colima mutex run includes one test that waits its full 120 s (`REAPED_WITHIN`) and fails. That is a test-fixture defect, not an engine difference (below). The whole ~50 s mutex gap is that wait: in the junit per-file sums, `docker-engine-store.test.ts` took 30.5, 35.1 and 32.4 s on Docker and 145.5, 145.3 and 145.6 s on Colima; without the wait it takes about 24.8 s on Colima against 27.8 s on Docker. So mutex is no evidence that Colima is slower; it is re-measured after the fixture fix. The testing suite is the cleanest comparison: Colima won all three runs, while its last two ran at load 59 and 43.

## Criterion 2: every suite green

| Run               | Failures | Failing test (file)                                                                                                                                                    | Cause in the junit                                                     |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 02-colima-mutex   | 1        | "a rung left by a killed test process is removed by the run's reaper after the run ends" (`packages/mutex/src/lock-stores/docker/docker-engine-store.test.ts`)         | `TimeoutError: The operation was aborted due to timeout` after 120.6 s |
| 04-colima-mutex   | 1        | the same test                                                                                                                                                          | the same, after 120.8 s                                                |
| 06-colima-mutex   | 1        | the same test                                                                                                                                                          | the same, after 120.7 s                                                |
| 03-docker-mutex   | 1        | Socket store protocol handshake: "a store hung up on during a failover follows the leader that took over" (`packages/mutex/src/lock-stores/socket/handshake.test.ts`)  | assertion: `'leader'`, expected `'follower'`; this test uses no engine |
| 01-docker-testing | 5        | all in `packages/testing/src/docker/reaper.integration.test.ts`, listed below                                                                                          | `ImageNotFoundError: No such image: alpine:latest`                     |
| 05-docker-testing | 1        | "a test process whose reaper was removed holds a new reaper at once, and that reaper removes what it creates after that, once it exits" (`reaper.integration.test.ts`) | `waitFor() timed out` after 33.7 s                                     |

The five reaper tests of 01-docker-testing:

- "one reaper of a run keeps the run's objects while one of its holders lives, and removes them, with their anonymous volumes, after the last one ended"
- "the reaper of a run keeps a shared server that carries the run's label"
- "a holder that comes during the grace stops the countdown, and the reaper acts after that holder ended"
- "a container that the engine creates after the first pass of the reaper is removed by a re-check pass"
- "a reaper whose removal fails tries it again one interval later, and removes the volume once the engine allows it"

What the failures say:

- **Colima's one failure is a test-fixture defect, not an engine defect.** `packages/mutex/src/testing/subjects/docker-engine.ts:107-109` builds `new DockerTestbed({ environment: run }).defaults()` with a `run` that holds only `ZUKHRUF_TESTING_RUN_ID` and `ZUKHRUF_TESTING_RUN_DIR`, with no `DOCKER_HOST` or `DOCKER_CONTEXT`. So the run's reaper is held on Docker Desktop (the current context of `config.json`) while the store uses Colima, and the test (`docker-engine-store.test.ts:857`) waits its full 120 s and fails in every Colima run; on Docker it passes in about 2.7 s. Proof: `docker events` showed the nested run's reaper created, started and destroyed on Docker Desktop and nothing on Colima. The defect came with commit 06d22ed3 (backlog #4205, which carries a note).
- **Docker Desktop's failures look environmental.** `alpine:latest` was missing on the shared Docker Desktop during 01-docker-testing, and the same error showed in pass 1's warm-up. Why it was missing is not established; a peer's image cleanup is a candidate. The 03-docker-mutex failure is a socket-store flake: the handshake test touches no engine.
- docker and testing were green on Colima in all 3 runs.

## Criterion 3: idle memory and container start

### Idle memory

`runs/idle-memory/20261116T082112Z`. Host memory of each engine's processes, in MiB: median of the two round medians, with the min to max of all 6 samples.

| Containers | Docker footprint    | Colima footprint    | Spread (Docker / Colima) | Colima minus Docker | Real? |
| ---------- | ------------------- | ------------------- | ------------------------ | ------------------- | ----- |
| 0          | 9122 (9111 to 9130) | 8388 (8386 to 8390) | 12 / 4                   | -734 (-8%)          | yes   |
| 1          | 9123 (9118 to 9126) | 8387 (8386 to 8388) | 4 / 2                    | -736 (-8%)          | yes   |
| 10         | 9112 (9104 to 9120) | 8387 (8386 to 8388) | 11 / 2                   | -725 (-8%)          | yes   |
| 30         | 9109 (9097 to 9123) | 8389 (8388 to 8390) | 0 / 2                    | -720 (-8%)          | yes   |

The VM's own footprint is flat at every level: 8250 MiB for Docker Desktop and 8211 MiB for Colima, close to the 8 GiB each guest was given. The whole gap is in the processes around the VM: about 860 to 880 MiB for Docker Desktop (`com.docker.backend` alone near 500 MiB, the Docker Desktop window near 180 MiB) against 174 to 178 MiB for Colima (two `limactl` and the ssh mux).

Footprint is the primary number because RSS was unstable. The Mac was under memory pressure: footprint's summary counts about 7.4 to 8.9 GB of the VM's memory as swapped or compressed. RSS counts only the pages resident at that moment, so it moves when macOS compresses or swaps the VM's memory. Footprint counts dirty memory whether resident or compressed, so it stays within 12 MiB across samples. The cost of footprint: it shows no cost per container, because each guest had touched its whole 8 GiB already.

RSS, secondary and noisy (same layout):

| Containers | Docker RSS          | Colima RSS         | Spread (Docker / Colima) |
| ---------- | ------------------- | ------------------ | ------------------------ |
| 0          | 1128 (898 to 1333)  | 537 (197 to 883)   | 403 / 678                |
| 1          | 1476 (1420 to 1525) | 796 (541 to 1049)  | 97 / 507                 |
| 10         | 1822 (1794 to 1836) | 670 (482 to 848)   | 27 / 339                 |
| 30         | 1900 (1435 to 2365) | 1103 (470 to 1268) | 891 / 252                |

Colima's RSS at 30 containers fell from 1229 to 470 MiB between two samples 10 s apart, with nothing started or stopped.

### Container start

`runs/startup-alpine-true/20261116T075712Z` (hyperfine, 30 runs per round) and `runs/postgres-time-to-ready/20261116T084831Z` (10 runs per round), in ms.

| Measure                              | Docker median (rounds; min to max)   | Colima median (rounds; min to max)   | Spread (Docker / Colima) | Colima minus Docker | Real?           |
| ------------------------------------ | ------------------------------------ | ------------------------------------ | ------------------------ | ------------------- | --------------- |
| `run --rm alpine true`, warm         | 153.1 (160.8, 145.3; 121.2 to 233.7) | 158.2 (158.2, 158.2; 132.7 to 244.6) | 15.5 / 0.0               | +5.1 (+3%)          | no              |
| `run --rm alpine true`, first run    | 1387 (one run)                       | 192 (one run)                        |                          |                     | one sample each |
| Postgres ready on the published port | 722.4 (752.3, 692.4; 683.6 to 765.7) | 701.4 (705.0, 697.8; 682.7 to 813.2) | 59.8 / 7.2               | -20.9 (-3%)         | no              |
| Postgres create to removed (total)   | 824.6 (854.2, 795.1)                 | 826.2 (837.4, 815.1)                 | 59.0 / 22.3              | +1.6 (0%)           | no              |
| Postgres start call                  | 46.6 (46.1, 47.2)                    | 58.6 (60.4, 56.9)                    | 1.1 / 3.5                | +12.0 (+26%)        | yes             |
| Postgres remove call                 | 103.8 (104.8, 102.8)                 | 124.5 (130.1, 118.9)                 | 2.0 / 11.2               | +20.7 (+20%)        | yes             |
| Postgres first TCP connect           | 64.3 (64.7, 63.8)                    | 77.5 (79.1, 75.9)                    | 0.9 / 3.2                | +13.3 (+21%)        | yes             |

Colima's start and remove calls are slower beyond the spread, but Postgres's own start (about 650 ms) hides that in the time to ready.

## Supporting experiments

### Engine API latency (socktainer-overhead, docker-cli arm only)

`runs/socktainer-overhead/20261116T075738Z`, hyperfine, 30 runs per round, in ms; load 17 to 62.

| Step     | Docker median (rounds; min to max)    | Colima median (rounds; min to max)    | Spread (Docker / Colima) | Colima minus Docker | Real? |
| -------- | ------------------------------------- | ------------------------------------- | ------------------------ | ------------------- | ----- |
| create   | 63.7 (64.0, 63.4; 38.8 to 199.0)      | 81.8 (115.6, 47.9; 32.2 to 351.8)     | 0.6 / 67.7               | +18.1               | no    |
| start    | 103.8 (80.9, 126.8; 63.2 to 389.6)    | 116.0 (142.2, 89.8; 71.6 to 251.7)    | 45.9 / 52.4              | +12.2               | no    |
| inspect  | 30.2 (29.9, 30.5; 21.1 to 83.7)       | 35.8 (35.9, 35.6; 18.0 to 146.7)      | 0.6 / 0.3                | +5.6 (+18%)         | yes   |
| rm       | 123.4 (131.7, 115.2; 94.4 to 270.1)   | 120.3 (128.2, 112.4; 88.4 to 327.2)   | 16.5 / 15.8              | -3.2                | no    |
| sequence | 287.6 (328.7, 246.4; 216.1 to 1905.4) | 435.8 (360.5, 511.0; 228.9 to 2017.5) | 82.3 / 150.0             | +148.2              | no    |

### Attach round trip (the lease shape of packages/testing)

`runs/attach-round-trip/20261116T084932Z`, 10 containers per round, round trips pooled (200 per round), in ms.

| Measure         | Docker (rounds)   | Colima (rounds)   | Spread (Docker / Colima) | Colima minus Docker | Real? |
| --------------- | ----------------- | ----------------- | ------------------------ | ------------------- | ----- |
| create          | 13.4 (13.3, 13.5) | 12.7 (12.5, 13.0) | 0.26 / 0.54              | -0.7                | yes   |
| attach          | 3.3 (3.3, 3.3)    | 1.4 (1.3, 1.4)    | 0.05 / 0.02              | -2.0                | yes   |
| start           | 41.5 (40.8, 42.2) | 50.9 (51.3, 50.6) | 1.4 / 0.7                | +9.4 (+23%)         | yes   |
| round trip      | 0.22 (0.22, 0.21) | 0.26 (0.26, 0.26) | 0.01 / 0.00              | +0.05               | yes   |
| close to exit   | 48.1 (46.8, 49.4) | 68.0 (67.0, 69.0) | 2.5 / 2.0                | +19.9 (+41%)        | yes   |
| exit to removed | 15.2 (15.2, 15.3) | 13.6 (13.6, 13.6) | 0.06 / 0.04              | -1.7                | yes   |

Summed over one lease (create, attach, start, close to exit, exit to removed): Docker 121.5 ms, Colima 146.6 ms.

### Storage (fio)

`runs/fio-storage/20261116T080108Z`, one 20 s job per cell and round; load 62 at the start. 4k cells in IOPS (MiB/s), 1m cells in MiB/s (equal to IOPS at 1 MiB blocks).

| Target | rw        | bs  | Docker         | Colima         | Spread (Docker / Colima) | Colima minus Docker | Real? |
| ------ | --------- | --- | -------------- | -------------- | ------------------------ | ------------------- | ----- |
| bind   | randread  | 4k  | 40328 (157.5)  | 35010 (136.8)  | 2667 / 2454              | -13%                | yes   |
| bind   | randread  | 1m  | 3402           | 1640           | 1693 / 2189              | -52%                | no    |
| bind   | randwrite | 4k  | 40158 (156.9)  | 12677 (49.5)   | 979 / 3389               | -68%                | yes   |
| bind   | randwrite | 1m  | 2917           | 1462           | 148 / 974                | -50%                | yes   |
| volume | randread  | 4k  | 133247 (520.5) | 154494 (603.5) | 120697 / 46305           | +16%                | no    |
| volume | randread  | 1m  | 37196          | 19999          | 5222 / 4730              | -46%                | yes   |
| volume | randwrite | 4k  | 143054 (558.8) | 97910 (382.5)  | 7025 / 28443             | -32%                | yes   |
| volume | randwrite | 1m  | 9183           | 6594           | 25 / 4004                | -28%                | no    |
| rootfs | randread  | 4k  | 172831 (675.1) | 170115 (664.6) | 12797 / 6224             | -2%                 | no    |
| rootfs | randread  | 1m  | 38774          | 28561          | 14843 / 6366             | -26%                | no    |
| rootfs | randwrite | 4k  | 96244 (376.0)  | 116004 (453.2) | 775 / 36788              | +21%                | no    |
| rootfs | randwrite | 1m  | 9171           | 9402           | 210 / 337                | +3%                 | no    |

### Network (iperf3) and CPU (sysbench)

`runs/iperf3-network/20261116T083641Z` (3 runs of 10 s per route and round) and `runs/sysbench-cpu/20261116T084130Z` (3 runs of 30 s per round, 2 threads, `--cpus 2`).

| Measure                       | Docker median (rounds; runs min to max) | Colima median (rounds; runs min to max) | Spread (Docker / Colima) | Colima minus Docker | Real? |
| ----------------------------- | --------------------------------------- | --------------------------------------- | ------------------------ | ------------------- | ----- |
| iperf3 container to container | 85.7 Gbit/s (79.6, 91.9; 78.8 to 92.6)  | 88.5 Gbit/s (87.9, 89.1; 85.5 to 101.0) | 12.3 / 1.2               | +2.8 (+3%)          | no    |
| iperf3 host to published port | 2.22 Gbit/s (2.42, 2.02; 1.63 to 2.44)  | 3.03 Gbit/s (3.08, 2.97; 2.91 to 3.08)  | 0.40 / 0.11              | +0.81 (+36%)        | yes   |
| sysbench cpu, events/s        | 21644 (21060, 22228; 20923 to 22983)    | 21606 (21258, 21953; 20669 to 22291)    | 1168 / 695               | -39 (0%)            | no    |

## Verdicts

| Experiment             | Verdict       | Why                                                                                                                                                  |
| ---------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| suites-wall-time       | mixed         | Colima 10% faster on testing, tied on docker; mutex's +51% is a fixture defect's 120 s wait, without which Colima leads; re-measure after the fix.   |
| startup-alpine-true    | no-difference | 153 against 158 ms; the 5 ms gap is inside Docker's 15.5 ms spread.                                                                                  |
| postgres-time-to-ready | no-difference | 722 against 701 ms to ready, inside Docker's 60 ms spread; Colima's slower start and remove calls hide under Postgres's own start.                   |
| socktainer-overhead    | docker-faster | Only inspect differs beyond the spread (+5.6 ms on Colima); create, start, rm and the sequence are within it.                                        |
| fio-storage            | docker-faster | Docker leads on bind mounts (4k write -68% on Colima, 1m write -50%, 4k read -13%) and named volumes; no real Colima lead; the root filesystem ties. |
| idle-memory            | colima-faster | Colima takes 720 to 736 MiB less footprint at every level, all of it Docker Desktop's processes around the VM.                                       |
| attach-round-trip      | docker-faster | A lease costs 25 ms more on Colima, mostly start (+9 ms) and close to exit (+20 ms); Colima wins attach and removal by 1 to 2 ms.                    |
| iperf3-network         | colima-faster | Host to published port 36% faster on Colima (3.03 against 2.22 Gbit/s); container to container ties.                                                 |
| sysbench-cpu           | no-difference | 21644 against 21606 events/s, inside both spreads.                                                                                                   |

## What this says for the switch so far

- Colima wins idle memory by about 730 MiB of footprint, all of it Docker Desktop's own processes.
- Colima wins the testing suite by about 10% (30 s), in every run.
- Colima wins host to published port on the network (+36%).
- Colima loses bind-mount and named-volume I/O (up to -68% at 4k writes) and attach close to exit by about 20 ms. The suites do not seem to feel it.
- mutex: re-measure after the fixture fix. Its 50 s gap and Colima's criterion-2 red are a test defect (the run's reaper held on Docker Desktop), not an engine defect; without the 120 s wait the store file is 24.8 s on Colima against 27.8 s on Docker.
- The docker suite ties.
- Container start, time to ready, CPU and network inside the VM tie.
- Docker Desktop had more noise than Colima: other sessions shared it, so its numbers lean slow.

Open before a verdict:

- The fixture fix for the run's reaper in `packages/mutex/src/testing/subjects/docker-engine.ts` (#4205).
- OrbStack, not installed yet, and Docker Desktop on Docker VMM, not switched yet: neither is measured.
- The Apple arm waits for a socktainer release built for container 1.7.1.
- A rerun of the suites once the fixture is fixed, to give Colima a clean mutex time.
