#!/usr/bin/env zsh
# Experiment 3, socktainer-overhead: latency of create, start, inspect and remove of one alpine
# container, step by step and as one sequence.
#
# Arms are the clients of each engine (BENCH_ARMS in lib.zsh). Every engine has the docker-cli arm:
# the docker CLI on its Engine API socket. On apple that socket is socktainer, and Apple's own CLI
# (container create/start/inspect/delete) is a second arm; both reach the same container-apiserver,
# so their difference is socktainer's cost per call. On the other engines (Docker Desktop, Colima,
# OrbStack) the docker-cli arm alone is the API-overhead baseline of that engine.
#
# Each step is one hyperfine run (--warmup 3 --runs 30, --shell=none) that times only that call:
# --prepare builds the state the step needs (and first removes a leftover of the same name),
# --conclude removes it; hyperfine always runs those two through sh.
# The whole-sequence arm chains the four calls with &&, so it needs a shell: it runs with
# --shell=default, so each of its runs includes one sh start. hyperfine 2.0 measures that start
# apart (its shell calibration) and subtracts it from every run, so the wall time is the four calls
# plus calibration noise of about a millisecond; see the README.

BENCH_USAGE="usage: socktainer-overhead.zsh [options]

Times create, start, inspect and rm (container delete on Apple's CLI) of one alpine container
running 'sleep 300' with --cpus 2 --memory 1g, per step and as one sequence."

source "${0:A:h}/lib.zsh"
bench_parse_args "$@"
bench_init socktainer-overhead
BENCH_NOTES+=(
  "rm is 'rm -f' on the docker CLI and 'container delete --force' on Apple's CLI; both stop a running container first"
  "inspect detail differs: the docker CLI prints the Engine API shape, Apple's CLI prints its own configuration and status"
  "the step arms run with hyperfine --shell=none; --prepare, --conclude, --setup and --cleanup always run through sh"
  "the sequence arm runs with hyperfine --shell=default: each run includes one sh start, which hyperfine measures apart (shell calibration) and subtracts"
)

# Prints the command line of one step for one arm. Steps: create run start inspect rm.
step_line() {
  local engine=$1 arm=$2 step=$3 name=$4
  local -a args
  case $step in
    create) args=(create --name $name $BENCH_LIMITS $IMAGE_ALPINE sleep 300) ;;
    run) args=(run -d --name $name $BENCH_LIMITS $IMAGE_ALPINE sleep 300) ;;
    start) args=(start $name) ;;
    inspect) args=(inspect $name) ;;
    rm) args=(rm -f $name) ;;
  esac
  [[ $arm == container-cli && $step == rm ]] && args=(delete --force $name)
  bench_arm_line $engine $arm $args
}

# A command that removes the container if it exists and never fails.
remove_line() {
  print -r -- "$(step_line $1 $2 rm $3) >/dev/null 2>&1; true"
}

measure_arm() {
  local engine=$1 slot=$2 arm=$3
  local name=$BENCH_NAME_PREFIX-$engine-$arm
  local -a hf=(hyperfine --style basic --warmup 3 --runs 30)
  local step
  local remove=$(remove_line $engine $arm $name)

  bench_run $hf -N --command-name "$engine $arm create" --export-json "$BENCH_OUT/$slot-$arm-create.json" \
    --prepare "$remove" --conclude "$remove" \
    "$(step_line $engine $arm create $name)"

  bench_run $hf -N --command-name "$engine $arm start" --export-json "$BENCH_OUT/$slot-$arm-start.json" \
    --prepare "$remove; $(step_line $engine $arm create $name) >/dev/null" --conclude "$remove" \
    "$(step_line $engine $arm start $name)"

  bench_run $hf -N --command-name "$engine $arm inspect" --export-json "$BENCH_OUT/$slot-$arm-inspect.json" \
    --setup "$remove; $(step_line $engine $arm run $name) >/dev/null" --cleanup "$remove" \
    "$(step_line $engine $arm inspect $name)"

  bench_run $hf -N --command-name "$engine $arm rm" --export-json "$BENCH_OUT/$slot-$arm-rm.json" \
    --prepare "$remove; $(step_line $engine $arm run $name) >/dev/null" --conclude "$remove" \
    "$(step_line $engine $arm rm $name)"

  # The && chain needs a shell; this arm includes one sh start per run (see the header).
  local sequence="$(step_line $engine $arm create $name) && $(step_line $engine $arm start $name) && $(step_line $engine $arm inspect $name) && $(step_line $engine $arm rm $name)"
  bench_run $hf --shell=default --command-name "$engine $arm sequence" --export-json "$BENCH_OUT/$slot-$arm-sequence.json" \
    --prepare "$remove" --conclude "$remove" \
    "$sequence"

  for step in create start inspect rm sequence; do
    bench_require_hyperfine "$BENCH_OUT/$slot-$arm-$step.json"
  done
}

measure_slot() {
  local engine=$1 slot=$2 arm
  for arm in ${=BENCH_ARMS[$engine]}; do
    measure_arm $engine $slot $arm
  done
}

bench_each_slot measure_slot
