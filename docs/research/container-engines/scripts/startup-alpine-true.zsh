#!/usr/bin/env zsh
# Experiment 1, startup-alpine-true: start-to-exit of `run --rm <alpine> true`.
#
# Arms: Docker Desktop through the docker CLI; Apple through socktainer (docker CLI on its socket);
# Apple through its own `container` CLI. Each arm gets one first run of the session, exported apart
# (first-<arm>.json), then hyperfine --warmup 3 --runs 30 per slot. The first run is a true cold
# start only right after an engine restart or update; the warm slots never include it.

BENCH_USAGE="usage: startup-alpine-true.zsh [options]

Times 'run --rm <alpine digest> true' with --cpus 2 --memory 1g on each engine (hyperfine -N,
--warmup 3, --runs 30). Apple runs two arms: docker CLI through socktainer, and 'container run'."

source "${0:A:h}/lib.zsh"
bench_parse_args "$@"
bench_init startup-alpine-true
BENCH_NOTES+=(
  "hyperfine runs with --shell=none; every arm's command includes the same gtimeout wrapper"
  "first-<arm>.json is the first run of this session for the arm, before any warm-up; it is cold only after an engine restart"
)

typeset -A first_done=()

measure() {
  local slot=$1 arm=$2 line=$3
  if [[ -z ${first_done[$arm]:-} ]]; then
    first_done[$arm]=1
    bench_run hyperfine -N --style basic --runs 1 --command-name "$arm (first)" \
      --export-json "$BENCH_OUT/first-$arm.json" "$line"
    bench_require_hyperfine "$BENCH_OUT/first-$arm.json"
  fi
  bench_run hyperfine -N --style basic --warmup 3 --runs 30 --command-name "$arm" \
    --export-json "$BENCH_OUT/$slot-$arm.json" "$line"
  bench_require_hyperfine "$BENCH_OUT/$slot-$arm.json"
}

measure_slot() {
  local engine=$1 slot=$2
  if [[ $engine == docker ]]; then
    measure $slot docker-cli "$(bench_dk_line docker run --rm $BENCH_LIMITS $IMAGE_ALPINE true)"
  else
    measure $slot apple-socktainer "$(bench_dk_line apple run --rm $BENCH_LIMITS $IMAGE_ALPINE true)"
    measure $slot apple-container-cli "$(bench_ac_line run --rm $BENCH_LIMITS $IMAGE_ALPINE true)"
  fi
}

bench_each_slot measure_slot
