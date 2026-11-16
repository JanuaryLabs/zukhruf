#!/usr/bin/env zsh
# Experiment 7, attach-round-trip: a cat lease attached before its start, through
# @zukhruf/docker (attach-round-trip.ts, one call per slot), then summary.tsv (client-summary.ts).
#
# Each slot: one first container, stored apart, then --containers containers. Each container:
# create, attach({ stdin: true }), start, --writes round trips of a 32-byte line, close stdin,
# exitCode, then the AutoRemove until an inspect gives 404.

BENCH_USAGE="usage: attach-round-trip.zsh [options] [--containers N] [--writes N]

Times attach, start, stdin-to-stdout round trips, close to exit and exit to removal of a cat
lease (alpine, Entrypoint cat, Cmd -, OpenStdin, StdinOnce, AutoRemove, --cpus 2 --memory 1g).
  --containers N  Containers per slot after the slot's first one (default 10).
  --writes N      Round trips per container (default 20)."

source "${0:A:h}/lib.zsh"
typeset -a opt_containers=() opt_writes=()
zparseopts -D -E -- -containers:=opt_containers -writes:=opt_writes
containers=${opt_containers[-1]:-10}
writes=${opt_writes[-1]:-20}
bench_require_positive "--containers and --writes take positive whole numbers" $containers $writes
bench_parse_args "$@"

typeset -gra NODE=(node --conditions=@zukhruf/source)

bench_init attach-round-trip
BENCH_NOTES+=(
  "client: @zukhruf/docker from packages/docker (node --conditions=@zukhruf/source); one node process per slot"
  "body: alpine, Entrypoint [cat], Cmd [-], OpenStdin, StdinOnce, AttachStdin, AutoRemove; NanoCpus $BENCH_CPUS e9, Memory $BENCH_MEMORY"
  "per slot: 1 first container (stored as 'first'), then $containers; $writes round trips of a 32-byte line per container, one at a time"
  "exit_to_removed_ms polls containers.inspect() every 10 ms until undefined (404); exit_to_removed_wait_ms is wait({condition: removed}) sent before the start, null where the engine rejects it (waitRemovedError in the slot file)"
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
  if (( ! BENCH_DRY_RUN )) && dk $engine image inspect $IMAGE_ALPINE >/dev/null 2>&1; then
    return 0
  fi
  bench_run dk $engine pull $IMAGE_ALPINE >/dev/null
  (( BENCH_DRY_RUN )) || BENCH_NOTES+=("$engine pulled $IMAGE_ALPINE at $(bench_utc), before the first slot")
}

for engine in $(bench_engines); do
  ensure_image $engine
done

measure_slot() {
  local engine=$1 slot=$2
  run_node "$BENCH_SCRIPTS_DIR/attach-round-trip.ts" --engine $engine --host $BENCH_SOCKET[$engine] \
    --slot $slot --containers $containers --writes $writes --cpus $BENCH_CPUS --memory $BENCH_MEMORY \
    --image $IMAGE_ALPINE --label $BENCH_LABEL --name-prefix $BENCH_NAME_PREFIX --out "$BENCH_OUT/$slot.json"
  # A failed run keeps its error in the slot file; fail the slot unless one measured run succeeded.
  bench_require_result "$BENCH_OUT/$slot.json" 'any(.runs[]; .error == null)'
}

bench_each_slot measure_slot
run_node "$BENCH_SCRIPTS_DIR/client-summary.ts" --dir "$BENCH_OUT"
bench_require_result "$BENCH_OUT/summary.tsv"
