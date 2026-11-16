#!/usr/bin/env zsh
# Experiment 1, startup-alpine-true: start-to-exit of `run --rm <alpine> true`.
#
# Arms are the clients of each engine (BENCH_ARMS in lib.zsh): the docker CLI on the engine's
# socket everywhere, and on apple also Apple's own `container` CLI. Each engine and arm gets one
# first run of the session, exported apart (first-<engine>-<arm>.json), then hyperfine --warmup 3
# --runs 30 per slot. The first run is a true cold start only right after an engine restart or
# update; the warm slots never include it.

BENCH_USAGE="usage: startup-alpine-true.zsh [options]

Times 'run --rm <alpine digest> true' with --cpus 2 --memory 1g on each engine (hyperfine -N,
--warmup 3, --runs 30), through each of the engine's arms (docker-cli; on apple also container-cli)."

source "${0:A:h}/lib.zsh"
bench_parse_args "$@"
bench_init startup-alpine-true
BENCH_NOTES+=(
  "hyperfine runs with --shell=none; every arm's command includes the same gtimeout wrapper"
  "first-<engine>-<arm>.json is the first run of this session for the engine and arm, before any warm-up; it is cold only after an engine restart"
)

typeset -A first_done=()

measure() {
  local engine=$1 slot=$2 arm=$3 line=$4
  if [[ -z ${first_done[$engine-$arm]:-} ]]; then
    first_done[$engine-$arm]=1
    bench_run hyperfine -N --style basic --runs 1 --command-name "$engine $arm (first)" \
      --export-json "$BENCH_OUT/first-$engine-$arm.json" "$line"
    bench_require_hyperfine "$BENCH_OUT/first-$engine-$arm.json"
  fi
  bench_run hyperfine -N --style basic --warmup 3 --runs 30 --command-name "$engine $arm" \
    --export-json "$BENCH_OUT/$slot-$arm.json" "$line"
  bench_require_hyperfine "$BENCH_OUT/$slot-$arm.json"
}

measure_slot() {
  local engine=$1 slot=$2 arm
  for arm in ${=BENCH_ARMS[$engine]}; do
    measure $engine $slot $arm "$(bench_arm_line $engine $arm run --rm $BENCH_LIMITS $IMAGE_ALPINE true)"
  done
}

bench_each_slot measure_slot
