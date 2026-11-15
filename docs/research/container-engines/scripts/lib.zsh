# Shared parts of the container-engine benchmark scripts. Each experiment script sources this file.
#
# It holds the engine sockets, the pinned images, the shared limits, the argument parser, the
# run folder and meta.json, the command log, and the cleanup of every container and volume
# labelled dev.zukhruf.bench=1 (at exit, also on Ctrl-C).

setopt errexit nounset pipefail
zmodload zsh/datetime

typeset -gr BENCH_SCRIPTS_DIR=${${(%):-%x}:A:h}
typeset -gr BENCH_RESEARCH_DIR=${BENCH_SCRIPTS_DIR:h}

typeset -gr BENCH_LABEL_KEY=dev.zukhruf.bench
typeset -gr BENCH_LABEL=${BENCH_LABEL_KEY}=1
typeset -gr BENCH_NAME_PREFIX=zukhruf-bench-$$

# Engine sockets. Override with BENCH_DOCKER_SOCKET and BENCH_APPLE_SOCKET.
typeset -gA BENCH_SOCKET=(
  docker ${BENCH_DOCKER_SOCKET:-unix://$HOME/.docker/run/docker.sock}
  apple ${BENCH_APPLE_SOCKET:-unix://${HOMEBREW_PREFIX:-/opt/homebrew}/var/run/socktainer/.socktainer/container.sock}
)

# Images, pinned to the linux/arm64 manifest digest so both engines run the same bytes.
# The tag and the multi-platform index digest are recorded beside each pin and in README.md.
# alpine:3.24.4, index sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
typeset -gr IMAGE_ALPINE=docker.io/library/alpine@sha256:1829893486be257df5049ab3b7fc95afbd0fc09d89803cbc580bda1ba5386b29
# openeuler/fio:3.43-oe2403sp4 (fio 3.43, libaio and io_uring built in), index sha256:7b7d4a5bfdc52accdc667dbe1d37c9c7ca6f313b9472eec6c84d41697d3cc607
typeset -gr IMAGE_FIO=docker.io/openeuler/fio@sha256:a9be517cbf3c63c500627d68680d2673a98fa8d5c9ed31179da75f0edff8a3ef
# openeuler/sysbench:1.0.20-oe2403sp4, index sha256:71ebf9d8564583b2fd47b1952f2fbe9739ad69c2eb3938ea89dc5cc4284516fe
typeset -gr IMAGE_SYSBENCH=docker.io/openeuler/sysbench@sha256:1950ba366eb34d88e4a4c9b50c90fb55b7467c8da379566b2acdaa597a5bcad7
# networkstatic/iperf3:latest as of 2026-11-01 (entrypoint iperf3), index sha256:d8767f2888155902ec72760f9ba8dd6fb16ff73256a8e02572c109aecc23269b
typeset -gr IMAGE_IPERF3=docker.io/networkstatic/iperf3@sha256:069fbed1f741659fb04abc283f21ac22e95d9ef307b14e31225ef7a180bfb2ed

# Limits of the measured container, the same on both engines. socktainer floors CPUs to whole vCPUs,
# so keep BENCH_CPUS a whole number. Apple adds one vCPU of overhead to each container VM
# (configuration.resources.cpuOverhead = 1); Docker applies the limit as a cgroup quota in its shared VM.
typeset -g BENCH_CPUS=2
typeset -g BENCH_MEMORY=1g
# The docker run flags for those limits and the label; bench_init sets it after a script may have changed BENCH_CPUS.
typeset -ga BENCH_LIMITS=()

# Seconds before gtimeout kills a docker or container CLI call that hangs.
typeset -g BENCH_CALL_TIMEOUT=${BENCH_CALL_TIMEOUT:-180}

typeset -g BENCH_ID=''
typeset -g BENCH_OUT=''
typeset -g BENCH_DRY_RUN=0
typeset -g BENCH_INITIALIZED=0
typeset -g BENCH_INTERRUPTED=0
typeset -g BENCH_STARTED_UTC=''
typeset -g BENCH_LOAD_START=''
typeset -ga BENCH_ORDER=()
typeset -ga BENCH_NOTES=()
typeset -gA BENCH_FOREIGN=()

# The script's own arguments, kept to re-run it under caffeinate.
typeset -ga BENCH_ARGV=("$@")

# Usage text of the calling script; it sets this before bench_parse_args.
typeset -g BENCH_USAGE=${BENCH_USAGE:-}

bench_common_usage() {
  cat <<EOF
Common options:
  --engine docker|apple   Run one engine only, once.
  --interleave N          Run both engines N times each, A,B,A,B (default: 2).
  --out DIR               Output folder (default: docs/research/container-engines/runs/<id>/<UTC timestamp>).
  --dry-run               Print every command instead of running it; writes nothing.
  -h, --help              Show this help.

Environment: BENCH_DOCKER_SOCKET, BENCH_APPLE_SOCKET, BENCH_CALL_TIMEOUT (seconds, default 180).
EOF
}

bench_die() {
  print -u2 -- "error: $*"
  exit 2
}

# Dies with the message unless every value after it is a positive whole number.
bench_require_positive() {
  local message=$1 value
  shift
  for value; do
    [[ $value == <1-> ]] || bench_die $message
  done
}

# Parses the common options. Call it after the script removed its own options with zparseopts -D -E.
bench_parse_args() {
  local -a help engine interleave out dry
  zparseopts -D -F -- h=help -help=help -engine:=engine -interleave:=interleave -out:=out -dry-run=dry ||
    { print -u2 -- "$BENCH_USAGE"; bench_common_usage >&2; exit 2; }
  if (( $#help )); then
    print -- "$BENCH_USAGE"
    print
    bench_common_usage
    exit 0
  fi
  (( $# == 0 )) || bench_die "unexpected arguments: $*"
  (( $#dry )) && BENCH_DRY_RUN=1
  (( $#out )) && BENCH_OUT=${out[-1]:A}
  if (( $#engine && $#interleave )); then
    bench_die "--engine and --interleave exclude each other"
  fi
  if (( $#engine )); then
    [[ ${engine[-1]} == (docker|apple) ]] || bench_die "--engine must be docker or apple"
    BENCH_ORDER=(${engine[-1]})
  else
    local rounds=${interleave[-1]:-2}
    bench_require_positive "--interleave takes a positive whole number" $rounds
    BENCH_ORDER=()
    repeat $rounds BENCH_ORDER+=(docker apple)
  fi
  # Long runs keep the Mac awake. Re-run this script under caffeinate once.
  if (( ! BENCH_DRY_RUN )) && [[ -z ${BENCH_CAFFEINATED:-} ]]; then
    BENCH_CAFFEINATED=1 exec caffeinate -dimsu zsh "$ZSH_ARGZERO" "${BENCH_ARGV[@]}"
  fi
}

# The engines of this run, each once, in first-use order.
bench_engines() {
  print -l -- ${(u)BENCH_ORDER}
}

# Slot label of the i-th run in BENCH_ORDER: 01-docker, 02-apple, ...
bench_slot() {
  printf '%02d-%s' $1 ${BENCH_ORDER[$1]}
}

# Prints "== <slot>" and calls <function> <engine> <slot> <index> for each run in BENCH_ORDER.
bench_each_slot() {
  local callback=$1 i slot
  for i in {1..$#BENCH_ORDER}; do
    slot=$(bench_slot $i)
    print -- "== $slot"
    $callback $BENCH_ORDER[$i] $slot $i
  done
}

# The command line as it runs: dk and ac expand to their docker and container CLI calls.
bench_expand_line() {
  case $1 in
    dk) bench_dk_line "${(@)@[2,-1]}" ;;
    ac) bench_ac_line "${(@)@[2,-1]}" ;;
    *) print -r -- ${(j: :)${(q-)@}} ;;
  esac
}

# Logs a command line to commands.log (and to stderr in a dry run).
bench_log_line() {
  local line=$1
  if (( BENCH_DRY_RUN )); then
    print -u2 -- "[dry-run] $line"
  else
    print -r -- "$line" >>"$BENCH_OUT/commands.log"
  fi
}

bench_log_cmd() {
  bench_log_line "$(bench_expand_line "$@")"
}

# Runs a command and logs it. In a dry run it only prints the command.
bench_run() {
  bench_log_cmd "$@"
  (( BENCH_DRY_RUN )) && return 0
  "$@"
}

# Like bench_run, for a command whose stdout is captured (an id, an IP). In a dry run it prints
# DRYRUN so that the captured value is not empty.
bench_output() {
  bench_log_cmd "$@"
  if (( BENCH_DRY_RUN )); then
    print -- DRYRUN
    return 0
  fi
  "$@"
}

# Runs a command with its stdout written to a file, and logs both. Returns the command's status.
bench_capture() {
  local file=$1
  shift
  bench_log_line "$(bench_expand_line "$@") > ${(q-)file}"
  (( BENCH_DRY_RUN )) && return 0
  "$@" >"$file"
}

bench_sleep() {
  (( BENCH_DRY_RUN )) && { print -u2 -- "[dry-run] sleep $1"; return 0; }
  sleep $1
}

# The docker CLI against an engine socket, under gtimeout.
dk() {
  local engine=$1
  shift
  gtimeout -s KILL $BENCH_CALL_TIMEOUT docker -H $BENCH_SOCKET[$engine] "$@"
}

# Apple's container CLI, under gtimeout.
ac() {
  gtimeout -s KILL $BENCH_CALL_TIMEOUT container "$@"
}

# A docker CLI command line for hyperfine (run with --shell=none), quoted.
bench_dk_line() {
  local engine=$1
  shift
  local -a words=(gtimeout -s KILL $BENCH_CALL_TIMEOUT docker -H $BENCH_SOCKET[$engine] "$@")
  print -r -- ${(j: :)${(q-)words}}
}

# A container CLI command line for hyperfine (run with --shell=none), quoted.
bench_ac_line() {
  local -a words=(gtimeout -s KILL $BENCH_CALL_TIMEOUT container "$@")
  print -r -- ${(j: :)${(q-)words}}
}

bench_loadavg() {
  local -a parts=(${=$(sysctl -n vm.loadavg)})
  print -r -- "[${parts[2]},${parts[3]},${parts[4]}]"
}

bench_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# Creates the run folder, checks the engines, records the start of meta.json.
bench_init() {
  BENCH_ID=$1
  local stamp=$(date -u +%Y%m%dT%H%M%SZ)
  [[ -n $BENCH_OUT ]] || BENCH_OUT=$BENCH_RESEARCH_DIR/runs/$BENCH_ID/$stamp
  BENCH_LIMITS=(--label $BENCH_LABEL --cpus $BENCH_CPUS --memory $BENCH_MEMORY)
  print -- "experiment: $BENCH_ID"
  print -- "order:      ${BENCH_ORDER[*]}"
  print -- "output:     $BENCH_OUT"
  if (( BENCH_DRY_RUN )); then
    return 0
  fi
  local engine
  for engine in $(bench_engines); do
    dk $engine version --format '{{.Server.Version}}' >/dev/null ||
      bench_die "the $engine engine does not answer on $BENCH_SOCKET[$engine]"
  done
  mkdir -p -- "$BENCH_OUT"
  : >"$BENCH_OUT/commands.log"
  BENCH_STARTED_UTC=$(bench_utc)
  BENCH_LOAD_START=$(bench_loadavg)
  BENCH_FOREIGN=()
  for engine in $(bench_engines); do
    if [[ $engine == apple ]]; then
      # Apple's own list covers the containers made through socktainer and through the CLI.
      BENCH_FOREIGN[$engine]=$(ac list --format json | jq length)
    else
      BENCH_FOREIGN[$engine]=$(dk $engine ps -q | wc -l | tr -d ' ')
    fi
    if (( BENCH_FOREIGN[$engine] > 0 )); then
      print -u2 -- "warning: $BENCH_FOREIGN[$engine] other container(s) running on $engine; recorded in meta.json"
    fi
  done
  BENCH_INITIALIZED=1
  bench_write_meta running
}

# Writes meta.json: versions, host, limits, images, commands, load average.
bench_write_meta() {
  local state=$1
  local load_end=null ended=null
  if [[ $state != running ]]; then
    load_end=$(bench_loadavg)
    ended="\"$(bench_utc)\""
  fi
  local docker_version=$(dk docker version --format json 2>/dev/null || print null)
  local apple_docker_version=$(dk apple version --format json 2>/dev/null || print null)
  local docker_info=$(dk docker info --format '{"ncpu":{{.NCPU}},"mem_total":{{.MemTotal}}}' 2>/dev/null || print null)
  local foreign=$(for k v in ${(kv)BENCH_FOREIGN}; do print -r -- "$k $v"; done | jq -Rn '[inputs | split(" ") | {(.[0]): (.[1] | tonumber)}] | add // {}')
  jq -n \
    --arg experiment "$BENCH_ID" \
    --arg state "$state" \
    --arg started "$BENCH_STARTED_UTC" \
    --argjson ended "$ended" \
    --argjson interrupted $(( BENCH_INTERRUPTED ? 1 : 0 )) \
    --argjson order "$(print -l -- $BENCH_ORDER | jq -R . | jq -s .)" \
    --arg cpus "$BENCH_CPUS" \
    --arg memory "$BENCH_MEMORY" \
    --arg label "$BENCH_LABEL" \
    --arg alpine "$IMAGE_ALPINE" \
    --arg fio "$IMAGE_FIO" \
    --arg sysbench "$IMAGE_SYSBENCH" \
    --arg iperf3 "$IMAGE_IPERF3" \
    --arg docker_socket "$BENCH_SOCKET[docker]" \
    --arg apple_socket "$BENCH_SOCKET[apple]" \
    --argjson docker_version "$docker_version" \
    --argjson apple_docker_version "$apple_docker_version" \
    --argjson docker_info "$docker_info" \
    --arg container_version "$(container --version 2>&1)" \
    --arg socktainer_version "$(socktainer --version 2>&1 | head -1)" \
    --arg hyperfine_version "$(hyperfine --version 2>&1)" \
    --arg macos "$(sw_vers -productVersion)" \
    --arg macos_build "$(sw_vers -buildVersion)" \
    --arg model "$(sysctl -n hw.model)" \
    --argjson ncpu "$(sysctl -n hw.ncpu)" \
    --argjson memsize "$(sysctl -n hw.memsize)" \
    --argjson load_start "${BENCH_LOAD_START:-null}" \
    --argjson load_end "$load_end" \
    --argjson foreign "$foreign" \
    --argjson notes "$(print -l -- $BENCH_NOTES | jq -R . | jq -s 'map(select(length > 0))')" \
    --rawfile commands "$BENCH_OUT/commands.log" \
    '{
      experiment: $experiment,
      state: $state,
      started_utc: $started,
      ended_utc: $ended,
      interrupted: ($interrupted == 1),
      order: $order,
      limits: {cpus: $cpus, memory: $memory},
      label: $label,
      images: {alpine: $alpine, fio: $fio, sysbench: $sysbench, iperf3: $iperf3},
      sockets: {docker: $docker_socket, apple: $apple_socket},
      versions: {
        docker_desktop: $docker_version,
        socktainer_engine_api: $apple_docker_version,
        container: $container_version,
        socktainer: $socktainer_version,
        hyperfine: $hyperfine_version
      },
      docker_desktop_vm: $docker_info,
      host: {macos: $macos, macos_build: $macos_build, model: $model, ncpu: $ncpu, memsize: $memsize},
      loadavg: {start: $load_start, end: $load_end},
      foreign_running_containers_at_start: $foreign,
      notes: $notes,
      commands: ($commands | split("\n") | map(select(length > 0)))
    }' >"$BENCH_OUT/meta.json.tmp"
  mv -- "$BENCH_OUT/meta.json.tmp" "$BENCH_OUT/meta.json"
}

# Removes every container and volume labelled dev.zukhruf.bench=1 on both engines. Touches nothing else.
bench_cleanup() {
  local engine ids
  for engine in docker apple; do
    ids=(${(f)"$(dk $engine ps -aq --filter label=$BENCH_LABEL 2>/dev/null)"})
    (( $#ids )) && dk $engine rm -f -v $ids >/dev/null 2>&1
    ids=(${(f)"$(dk $engine volume ls -q --filter label=$BENCH_LABEL 2>/dev/null)"})
    (( $#ids )) && dk $engine volume rm -f $ids >/dev/null 2>&1
  done
  # Containers made with Apple's own CLI carry the label in their configuration.
  ids=(${(f)"$(ac list --all --format json 2>/dev/null |
    jq -r --arg k $BENCH_LABEL_KEY '.[] | select(.configuration.labels[$k] == "1") | .id' 2>/dev/null)"})
  (( $#ids )) && ac delete --force $ids >/dev/null 2>&1
  return 0
}

bench_on_exit() {
  local rc=$?
  (( BENCH_INITIALIZED )) || return 0
  BENCH_INITIALIZED=0
  setopt noerrexit
  print -- "cleaning up containers and volumes labelled $BENCH_LABEL"
  bench_cleanup
  local state=failed
  (( rc == 0 )) && state=done
  (( BENCH_INTERRUPTED )) && state=interrupted
  bench_write_meta $state
  print -- "meta: $BENCH_OUT/meta.json"
}

trap bench_on_exit EXIT
trap 'BENCH_INTERRUPTED=1; exit 130' INT TERM HUP
