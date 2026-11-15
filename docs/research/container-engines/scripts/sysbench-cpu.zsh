#!/usr/bin/env zsh
# Experiment 9, sysbench-cpu: events per second of sysbench cpu.
#
# Per slot: one discarded 5 s warm-up run, then --repeats measured runs, each a fresh
# 'run --rm' container with --cpus <threads' CPUs> --memory 1g. sysbench 1.0.20 has no JSON output,
# so each run's text is kept and summary.tsv lists the events per second of every run.

BENCH_USAGE="usage: sysbench-cpu.zsh [options] [--threads N] [--cpus N] [--time S] [--repeats N]

  --threads N   sysbench threads (default 2).
  --cpus N      CPUs of the container, whole vCPUs (default 2).
  --time S      Seconds per measured run (default 30).
  --repeats N   Measured runs per slot (default 3)."

source "${0:A:h}/lib.zsh"
typeset -a opt_threads=() opt_cpus=() opt_time=() opt_repeats=()
zparseopts -D -E -- -threads:=opt_threads -cpus:=opt_cpus -time:=opt_time -repeats:=opt_repeats
threads=${opt_threads[-1]:-2}
BENCH_CPUS=${opt_cpus[-1]:-$BENCH_CPUS}
duration=${opt_time[-1]:-30}
repeats=${opt_repeats[-1]:-3}
bench_require_positive "--threads, --cpus, --time and --repeats take positive whole numbers" $threads $BENCH_CPUS $duration $repeats
bench_parse_args "$@"
bench_init sysbench-cpu
BENCH_NOTES+=(
  "sysbench cpu --threads=$threads --time=$duration run (default --cpu-max-prime=10000); container --cpus $BENCH_CPUS --memory $BENCH_MEMORY"
  "Apple gives the container VM $BENCH_CPUS vCPUs plus one of overhead; Docker caps the container at $BENCH_CPUS CPUs of its shared VM with a cgroup quota"
)

BENCH_CALL_TIMEOUT=$(( duration + 120 ))

sysbench_line() {
  print -r -- sysbench cpu --threads=$threads --time=$1 run
}

measure_slot() {
  local engine=$1 slot=$2 n
  local -a run=(dk $engine run --rm $BENCH_LIMITS $IMAGE_SYSBENCH)
  bench_capture /dev/null $run ${=$(sysbench_line 5)}
  for n in {1..$repeats}; do
    bench_capture "$BENCH_OUT/$slot-run-$n.txt" $run ${=$(sysbench_line $duration)}
  done
}

bench_each_slot measure_slot

if (( ! BENCH_DRY_RUN )); then
  {
    print -- "slot\trun\tevents_per_second"
    for file in "$BENCH_OUT"/*-run-*.txt(N); do
      name=${file:t:r}
      print -- "${name%-run-*}\t${name##*-run-}\t$(awk '/events per second:/ { print $4 }' "$file")"
    done
  } >"$BENCH_OUT/summary.tsv"
fi
