#!/usr/bin/env zsh
# Experiment 2, postgres-time-to-ready: create until Postgres answers, on postgres:18-alpine,
# through @zukhruf/docker (postgres-time-to-ready.ts, one call per slot), then summary.tsv
# (client-summary.ts).
#
# Each slot: one first run (it includes any image unpack), stored apart, then --runs runs.
# Each run: create, start, poll every 50 ms (cap 60 s) the in-container pg_isready oracle, the
# published 127.0.0.1 port and, on engines whose container IPs the Mac reaches (BENCH_HOST_IP in
# lib.zsh: Apple), the container IP; then remove. The image is pulled
# before the first slot if an engine lacks it.

BENCH_USAGE="usage: postgres-time-to-ready.zsh [options] [--runs N]

Times create until pg_isready answers on postgres:18-alpine (pinned by digest), with the Env of
packages/testing/src/databases/postgres.ts, a tmpfs data folder and --cpus 2 --memory 1g.
  --runs N   Runs per slot after the slot's first run (default 10)."

source "${0:A:h}/lib.zsh"
typeset -a opt_runs=()
zparseopts -D -E -- -runs:=opt_runs
runs=${opt_runs[-1]:-10}
bench_require_positive "--runs takes a positive whole number" $runs
bench_parse_args "$@"

# postgres:18-alpine (PostgreSQL 18.7, image created 2026-11-12), linux/arm64 manifest digest;
# index sha256:b6972e1115a4ff8eba5d7f7d19184926d1e16d7d1136ae1e1a7ebf286da0f015
typeset -gr IMAGE_POSTGRES=docker.io/library/postgres@sha256:aea692538b8982646f587a0dc0263986ac063c043ab28a43076a07d099a0ef53
typeset -gra NODE=(node --conditions=@zukhruf/source)

bench_init postgres-time-to-ready
BENCH_NOTES+=(
  "image: postgres:18-alpine $IMAGE_POSTGRES"
  "client: @zukhruf/docker from packages/docker (node --conditions=@zukhruf/source); one node process per slot"
  "body: Env and MemorySwappiness 0 of packages/testing/src/databases/postgres.ts; NanoCpus $BENCH_CPUS e9, Memory $BENCH_MEMORY; 5432/tcp published on 127.0.0.1 with HostPort \"\""
  "data folder on tmpfs through HostConfig.Mounts [{Type: tmpfs, Target: /var/lib/postgresql, SizeBytes 512 MiB, Mode 01777}] on EVERY engine: socktainer ignores HostConfig.Tmpfs (backlog #4434)"
  "per slot: 1 first run (stored as 'first'), then $runs runs; poll every 50 ms, cap 60 s"
  "oracle: exec pg_isready -h 127.0.0.1 -U postgres -t 1; published and ip paths: TCP connect plus a Postgres SSLRequest answered 'S' or 'N'; ready_<path>_ms = max(oracle, answer on the path)"
  "the ip path (host to the container IP) runs only where BENCH_HOST_IP is 1 (Apple); Docker Desktop's and Colima's container IPs are not reachable from the host"
)

# Logs a node call; in a dry run, runs it with --dry-run so that it prints its plan and touches no engine.
run_node() {
  bench_log_cmd $NODE "$@"
  if (( BENCH_DRY_RUN )); then
    $NODE "$@" --dry-run
  else
    $NODE "$@"
  fi
}

ensure_image() {
  local engine=$1
  if (( ! BENCH_DRY_RUN )) && dk $engine image inspect $IMAGE_POSTGRES >/dev/null 2>&1; then
    return 0
  fi
  bench_run dk $engine pull $IMAGE_POSTGRES >/dev/null
  (( BENCH_DRY_RUN )) || BENCH_NOTES+=("$engine pulled $IMAGE_POSTGRES at $(bench_utc), before the first slot")
}

for engine in $(bench_engines); do
  ensure_image $engine
done

measure_slot() {
  local engine=$1 slot=$2
  local -a ip_path=()
  (( BENCH_HOST_IP[$engine] )) && ip_path=(--ip-path)
  run_node "$BENCH_SCRIPTS_DIR/postgres-time-to-ready.ts" --engine $engine --host $BENCH_SOCKET[$engine] $ip_path \
    --slot $slot --runs $runs --cpus $BENCH_CPUS --memory $BENCH_MEMORY --image $IMAGE_POSTGRES \
    --label $BENCH_LABEL --name-prefix $BENCH_NAME_PREFIX --out "$BENCH_OUT/$slot.json"
  # A failed run keeps its error in the slot file; fail the slot unless one measured run succeeded.
  bench_require_result "$BENCH_OUT/$slot.json" 'any(.runs[]; .error == null)'
}

bench_each_slot measure_slot
run_node "$BENCH_SCRIPTS_DIR/client-summary.ts" --dir "$BENCH_OUT"
bench_require_result "$BENCH_OUT/summary.tsv"
