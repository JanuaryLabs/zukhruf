#!/usr/bin/env zsh
# Experiment 6, idle-memory: host memory of each engine's processes with 0, 1, 10 and 30 idle
# containers (alpine, sleep infinity, --cpus 2 --memory 1g each).
#
# Per slot the engine climbs 0 -> 1 -> 10 -> 30 containers. At each level the script waits
# --settle seconds, then takes --samples samples --interval seconds apart with engine-memory.ts,
# which sums the RSS of the engine's host processes (helpers, socktainer, attributed VM processes)
# and records footprint. After 30 the slot's containers are removed and the next slot waits
# --settle seconds before its level 0.
#
# Other containers on an engine change its memory, so the script refuses to start while any run,
# unless --allow-foreign.

BENCH_USAGE="usage: idle-memory.zsh [options] [--settle S] [--samples N] [--interval S] [--allow-foreign]

Samples host memory of each engine at 0, 1, 10 and 30 idle containers.
  --settle S       Seconds to wait at each level before sampling (default 30).
  --samples N      Samples per level (default 3).
  --interval S     Seconds between samples (default 10).
  --allow-foreign  Run even when other containers run on an engine."

source "${0:A:h}/lib.zsh"
typeset -a opt_settle=() opt_samples=() opt_interval=() opt_foreign=()
zparseopts -D -E -- -settle:=opt_settle -samples:=opt_samples -interval:=opt_interval -allow-foreign=opt_foreign
settle=${opt_settle[-1]:-30}
samples=${opt_samples[-1]:-3}
interval=${opt_interval[-1]:-10}
bench_require_positive "--settle, --samples and --interval take positive whole numbers" $settle $samples $interval
bench_parse_args "$@"
bench_init idle-memory
BENCH_NOTES+=(
  "levels 0 1 10 30; settle ${settle}s; $samples samples ${interval}s apart; containers: alpine sleep infinity, --cpus $BENCH_CPUS --memory $BENCH_MEMORY"
  "VM processes are attributed by start time to com.docker.virtualization or container-runtime-linux (see engine-memory.ts)"
  "Docker Desktop's VM RSS moves with its balloon and page cache, so compare samples, not one reading"
  "rss_kib_without_ui leaves out the Docker Desktop window processes"
)

if (( ! BENCH_DRY_RUN && ! $#opt_foreign )); then
  for engine in $(bench_engines); do
    (( BENCH_FOREIGN[$engine] == 0 )) ||
      bench_die "$BENCH_FOREIGN[$engine] other container(s) run on $engine; stop them or pass --allow-foreign"
  done
fi

levels=(0 1 10 30)

sample_level() {
  local engine=$1 slot=$2 level=$3 n
  bench_sleep $settle
  for n in {1..$samples}; do
    (( n > 1 )) && bench_sleep $interval
    bench_run node "$BENCH_SCRIPTS_DIR/engine-memory.ts" --engine $engine --footprint \
      --out "$BENCH_OUT/$slot-level-$(printf %02d $level)-sample-$n.json"
  done
}

climb_slot() {
  local engine=$1 slot=$2 index=$3 level
  local running=0
  (( index > 1 )) && bench_sleep $settle
  for level in $levels; do
    while (( running < level )); do
      (( running += 1 ))
      bench_run dk $engine run -d --name $BENCH_NAME_PREFIX-idle-$slot-$running $BENCH_LIMITS \
        $IMAGE_ALPINE sleep infinity >/dev/null
    done
    print -- "   $level container(s)"
    sample_level $engine $slot $level
  done
  local -a ids=(${(f)"$(bench_output dk $engine ps -aq --filter label=$BENCH_LABEL)"})
  if (( $#ids )); then
    bench_run dk $engine rm -f $ids >/dev/null
  fi
}

bench_each_slot climb_slot
