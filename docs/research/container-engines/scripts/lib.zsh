# Shared parts of the container-engine benchmark scripts. Each experiment script sources this file.
#
# It holds the engine table, the pinned images, the shared limits, the argument parser, the
# run folder and meta.json, the command log, and the cleanup of every container and volume
# labelled dev.zukhruf.bench=1 on the engines of the run (at exit, also on Ctrl-C).

setopt errexit nounset pipefail
zmodload zsh/datetime

typeset -gr BENCH_SCRIPTS_DIR=${${(%):-%x}:A:h}
typeset -gr BENCH_RESEARCH_DIR=${BENCH_SCRIPTS_DIR:h}

typeset -gr BENCH_LABEL_KEY=dev.zukhruf.bench
typeset -gr BENCH_LABEL=${BENCH_LABEL_KEY}=1
typeset -gr BENCH_NAME_PREFIX=zukhruf-bench-$$

# The engine table. Every engine is reached through its Docker Engine API socket (docker -H); a
# script never changes the current docker context. Per engine:
#   BENCH_SOCKET       the socket; override with BENCH_<NAME>_SOCKET (BENCH_DOCKER_SOCKET, ...)
#   BENCH_CONTEXT      the docker context that names the same socket; recorded in meta.json only
#   BENCH_MEMORY_RULE  how engine-memory.ts attributes host processes to the engine; empty means
#                      not verified yet, and idle-memory.zsh refuses the engine
#   BENCH_ARMS         the clients that drive the engine: docker-cli everywhere, plus Apple's
#                      container CLI on apple
#   BENCH_HOST_IP      1 when the Mac reaches a container's IP directly (the ip paths of
#                      iperf3-network and postgres-time-to-ready), 0 when it does not
# docker-vmm is not a second engine: it is Docker Desktop's socket, measured while Docker Desktop
# runs on its Docker VMM hypervisor. bench_init refuses docker-vmm unless the processes show VMM,
# and docker unless they show the Apple Virtualization framework (see bench_docker_desktop_hypervisor).
typeset -gr BENCH_DOCKER_DESKTOP_SOCKET=${BENCH_DOCKER_SOCKET:-unix://$HOME/.docker/run/docker.sock}
typeset -gA BENCH_SOCKET=(
  docker $BENCH_DOCKER_DESKTOP_SOCKET
  docker-vmm $BENCH_DOCKER_DESKTOP_SOCKET
  colima ${BENCH_COLIMA_SOCKET:-unix://$HOME/.colima/default/docker.sock}
  orbstack ${BENCH_ORBSTACK_SOCKET:-unix://$HOME/.orbstack/run/docker.sock}
  apple ${BENCH_APPLE_SOCKET:-unix://${HOMEBREW_PREFIX:-/opt/homebrew}/var/run/socktainer/.socktainer/container.sock}
)
typeset -gA BENCH_CONTEXT=(
  docker desktop-linux
  docker-vmm desktop-linux
  colima colima
  orbstack orbstack
  apple ''
)
typeset -gA BENCH_MEMORY_RULE=(
  docker 'Docker.app and com.docker.* processes, plus the Virtualization VM process paired by start time with com.docker.virtualization'
  docker-vmm 'Docker.app and com.docker.* processes; the VM runs inside com.docker.krun, so no Virtualization VM process is expected'
  colima 'limactl processes and the ssh mux of ~/.colima/_lima, plus the Virtualization VM process paired by start time with the limactl hostagent (its pid is in ~/.colima/_lima/colima/vz.pid)'
  orbstack ''
  apple 'container-* processes and socktainer, plus each Virtualization VM process paired by start time with a container-runtime-linux'
)
typeset -gA BENCH_ARMS=(
  docker docker-cli
  docker-vmm docker-cli
  colima docker-cli
  orbstack docker-cli
  apple 'docker-cli container-cli'
)
# OrbStack documents direct container IPs from the Mac; set 1 once that is verified on install.
typeset -gA BENCH_HOST_IP=(
  docker 0
  docker-vmm 0
  colima 0
  orbstack 0
  apple 1
)
typeset -gr BENCH_DEFAULT_ENGINES=docker,colima

# Images, pinned to the linux/arm64 manifest digest so every engine runs the same bytes.
# The tag and the multi-platform index digest are recorded beside each pin and in README.md.
# alpine:3.24.4, index sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
typeset -gr IMAGE_ALPINE=docker.io/library/alpine@sha256:1829893486be257df5049ab3b7fc95afbd0fc09d89803cbc580bda1ba5386b29
# openeuler/fio:3.43-oe2403sp4 (fio 3.43, libaio and io_uring built in), index sha256:7b7d4a5bfdc52accdc667dbe1d37c9c7ca6f313b9472eec6c84d41697d3cc607
typeset -gr IMAGE_FIO=docker.io/openeuler/fio@sha256:a9be517cbf3c63c500627d68680d2673a98fa8d5c9ed31179da75f0edff8a3ef
# openeuler/sysbench:1.0.20-oe2403sp4, index sha256:71ebf9d8564583b2fd47b1952f2fbe9739ad69c2eb3938ea89dc5cc4284516fe
typeset -gr IMAGE_SYSBENCH=docker.io/openeuler/sysbench@sha256:1950ba366eb34d88e4a4c9b50c90fb55b7467c8da379566b2acdaa597a5bcad7
# networkstatic/iperf3:latest as of 2026-11-01 (entrypoint iperf3), index sha256:d8767f2888155902ec72760f9ba8dd6fb16ff73256a8e02572c109aecc23269b
typeset -gr IMAGE_IPERF3=docker.io/networkstatic/iperf3@sha256:069fbed1f741659fb04abc283f21ac22e95d9ef307b14e31225ef7a180bfb2ed

# Limits of the measured container, the same on every engine. socktainer floors CPUs to whole vCPUs,
# so keep BENCH_CPUS a whole number. Apple adds one vCPU of overhead to each container VM
# (configuration.resources.cpuOverhead = 1); the shared-VM engines (Docker Desktop, Colima, OrbStack)
# apply the limit as a cgroup quota inside their one VM.
typeset -g BENCH_CPUS=2
typeset -g BENCH_MEMORY=1g
# The docker run flags for those limits and the label; bench_init sets it after a script may have changed BENCH_CPUS.
typeset -ga BENCH_LIMITS=()

typeset -gi BENCH_EXIT_STATUS=0

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
# Docker Desktop's hypervisor as bench_init found it (vz, vmm or unknown), and the evidence.
typeset -g BENCH_DD_HYPERVISOR=''
typeset -g BENCH_DD_EVIDENCE=null

# The script's own arguments, kept to re-run it under caffeinate.
typeset -ga BENCH_ARGV=("$@")

# Usage text of the calling script; it sets this before bench_parse_args.
typeset -g BENCH_USAGE=${BENCH_USAGE:-}

bench_common_usage() {
  cat <<EOF
Common options:
  --engines A,B[,C]   The engines and their order (default: $BENCH_DEFAULT_ENGINES).
  --interleave N      Repeat the whole order N times, A,B,C,A,B,C (default: 2).
  --engine NAME       Run one engine only, once.
  --out DIR           Output folder (default: docs/research/container-engines/runs/<id>/<UTC timestamp>).
  --dry-run           Print every command instead of running it; writes nothing.
  -h, --help          Show this help.

Engines: ${(j:, :)${(@ok)BENCH_SOCKET}}. docker-vmm is Docker Desktop's socket while Docker Desktop
runs on Docker VMM; it never runs in the same order as docker.

Environment: BENCH_DOCKER_SOCKET, BENCH_COLIMA_SOCKET, BENCH_ORBSTACK_SOCKET, BENCH_APPLE_SOCKET,
BENCH_CALL_TIMEOUT (seconds, default 180).
EOF
}

bench_die() {
  print -u2 -- "error: $*"
  exit 2
}

# Fails the experiment: a measurement gave no result. meta.json ends with state "failed".
bench_fail() {
  print -u2 -- "FAILED: $*"
  exit 1
}

# Fails the experiment unless a result file exists and is not empty. A .json file must also parse,
# and give a value other than false or null for the jq filter (default: the whole document).
bench_require_result() {
  local file=$1 filter=${2:-.}
  (( BENCH_DRY_RUN )) && return 0
  [[ -s $file ]] || bench_fail "measured nothing: $file is missing or empty"
  if [[ $file == *.json ]] && ! jq -e "$filter" "$file" >/dev/null 2>&1; then
    bench_fail "$file is not the expected JSON (jq -e '$filter' fails)"
  fi
}

# hyperfine 2.0 keeps its timings, in seconds, at .results[i].summary.time_wall_clock.
bench_require_hyperfine() {
  bench_require_result $1 '.results | length > 0 and all(.summary.time_wall_clock.median | type == "number")'
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
  local -a help engine engines interleave out dry
  zparseopts -D -F -- h=help -help=help -engine:=engine -engines:=engines -interleave:=interleave -out:=out -dry-run=dry ||
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
  local -a order
  if (( $#engine )); then
    (( $#engines || $#interleave )) && bench_die "--engine runs one engine once; it excludes --engines and --interleave"
    order=(${engine[-1]})
  else
    order=(${(s:,:)${engines[-1]:-$BENCH_DEFAULT_ENGINES}})
  fi
  local name
  for name in $order; do
    (( ${+BENCH_SOCKET[$name]} )) || bench_die "unknown engine '$name'; known: ${(j:, :)${(@ok)BENCH_SOCKET}}"
  done
  local -a distinct=(${(u)order})
  (( $#order == $#distinct )) || bench_die "--engines names an engine twice: ${(j:,:)order}"
  if (( ${order[(Ie)docker]} && ${order[(Ie)docker-vmm]} )); then
    bench_die "docker and docker-vmm are one socket under two hypervisors; run them in separate runs"
  fi
  local rounds=${interleave[-1]:-2}
  (( $#engine )) && rounds=1
  bench_require_positive "--interleave takes a positive whole number" $rounds
  BENCH_ORDER=()
  repeat $rounds BENCH_ORDER+=($order)
  # Long runs keep the Mac awake. Re-run this script under caffeinate once.
  if (( ! BENCH_DRY_RUN )) && [[ -z ${BENCH_CAFFEINATED:-} ]]; then
    BENCH_CAFFEINATED=1 exec caffeinate -dimsu zsh "$ZSH_ARGZERO" "${BENCH_ARGV[@]}"
  fi
}

# The engines of this run, each once, in first-use order.
bench_engines() {
  print -l -- ${(u)BENCH_ORDER}
}

# Slot label of the i-th run in BENCH_ORDER: 01-docker, 02-colima, ...
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

# True when the engine is in this run.
bench_in_run() {
  (( ${BENCH_ORDER[(Ie)$1]} ))
}

# True when the run uses Docker Desktop's socket, as docker or as docker-vmm.
bench_in_docker_desktop() {
  bench_in_run docker || bench_in_run docker-vmm
}

# The command line of one arm (a client of the engine) for hyperfine (--shell=none), quoted:
# docker-cli is the docker CLI on the engine's socket, container-cli is Apple's container CLI.
bench_arm_line() {
  local engine=$1 arm=$2
  shift 2
  case $arm in
    docker-cli) bench_dk_line $engine "$@" ;;
    container-cli) bench_ac_line "$@" ;;
    *) bench_die "unknown arm $arm" ;;
  esac
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

# Runs a command with its stdout written to a file, and logs both. Unless the file is /dev/null,
# fails the experiment when the file is empty or, for .json, does not parse. Otherwise returns the
# command's status, so a caller can keep a failed run's output (iperf3's error JSON) and go on.
bench_capture() {
  local file=$1 rc=0
  shift
  bench_log_line "$(bench_expand_line "$@") > ${(q-)file}"
  (( BENCH_DRY_RUN )) && return 0
  "$@" >"$file" || rc=$?
  [[ $file == /dev/null ]] || bench_require_result "$file"
  return $rc
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

# Docker Desktop's hypervisor, from its host processes: com.docker.virtualization drives a VM of
# Apple's Virtualization framework (vz), com.docker.krun drives Docker VMM, built on libkrun (vmm).
# docker info has no hypervisor field (on VZ it says OperatingSystem "Docker Desktop", KernelVersion
# *-linuxkit), so the processes decide; OperatingSystem and KernelVersion are kept beside them in
# meta.json. Sets BENCH_DD_HYPERVISOR to vz, vmm or unknown (neither or both run) and BENCH_DD_EVIDENCE.
bench_docker_desktop_hypervisor() {
  local -a comms=(${(f)"$(ps -axo comm=)"})
  local vz=false vmm=false
  (( ${comms[(I)*/com.docker.virtualization]} )) && vz=true
  (( ${comms[(I)*/com.docker.krun]} )) && vmm=true
  case $vz/$vmm in
    true/false) BENCH_DD_HYPERVISOR=vz ;;
    false/true) BENCH_DD_HYPERVISOR=vmm ;;
    *) BENCH_DD_HYPERVISOR=unknown ;;
  esac
  local info
  info=$(gtimeout -s KILL 30 docker -H $BENCH_DOCKER_DESKTOP_SOCKET info \
    --format '{"operating_system":{{json .OperatingSystem}},"kernel_version":{{json .KernelVersion}}}' 2>/dev/null) || info=null
  jq -e . <<<"$info" >/dev/null 2>&1 || info=null
  BENCH_DD_EVIDENCE=$(jq -nc --arg detected $BENCH_DD_HYPERVISOR --argjson vz $vz --argjson vmm $vmm --argjson info "$info" \
    '{detected: $detected, process_com_docker_virtualization: $vz, process_com_docker_krun: $vmm, docker_info: $info}')
}

# Refuses a Docker Desktop label (docker, docker-vmm) whose hypervisor the processes do not show.
bench_check_docker_desktop_label() {
  local engine=$1 want=$2
  bench_in_run $engine || return 0
  [[ $BENCH_DD_HYPERVISOR == $want ]] && return 0
  if [[ $BENCH_DD_HYPERVISOR == unknown ]]; then
    bench_die "cannot tell Docker Desktop's hypervisor for '$engine': com.docker.virtualization (VZ) and com.docker.krun (Docker VMM) run both or neither; evidence: $BENCH_DD_EVIDENCE"
  fi
  bench_die "'$engine' needs Docker Desktop on ${${want:/vz/the Apple Virtualization framework}:/vmm/Docker VMM}, but its processes show $BENCH_DD_HYPERVISOR; evidence: $BENCH_DD_EVIDENCE"
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
  if bench_in_docker_desktop; then
    bench_docker_desktop_hypervisor
    bench_check_docker_desktop_label docker vz
    bench_check_docker_desktop_label docker-vmm vmm
    print -- "docker desktop hypervisor: $BENCH_DD_HYPERVISOR"
  fi
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

# Prints a command's stdout when it is JSON, else null.
bench_json_or_null() {
  local text
  text=$("$@" 2>/dev/null) || text=''
  if [[ -n $text ]] && jq -e . <<<"$text" >/dev/null 2>&1; then
    print -r -- "$text"
  else
    print null
  fi
}

# One meta.json entry per engine of the run: socket, context, its endpoint, arms, the memory rule,
# whether container IPs are reachable from the host, docker version and a slice of docker info.
bench_engines_json() {
  local entries='{}' engine context context_host
  for engine in $(bench_engines); do
    context=$BENCH_CONTEXT[$engine] context_host=''
    [[ -n $context ]] &&
      context_host=$(gtimeout -s KILL 30 docker context inspect $context --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)
    entries=$(jq -c \
      --arg engine $engine \
      --arg socket $BENCH_SOCKET[$engine] \
      --arg context "$context" \
      --arg context_host "$context_host" \
      --arg arms "$BENCH_ARMS[$engine]" \
      --arg memory_rule "$BENCH_MEMORY_RULE[$engine]" \
      --argjson host_ip $BENCH_HOST_IP[$engine] \
      --argjson version "$(bench_json_or_null dk $engine version --format json)" \
      --argjson info "$(bench_json_or_null dk $engine info --format '{"name":{{json .Name}},"operating_system":{{json .OperatingSystem}},"kernel_version":{{json .KernelVersion}},"server_version":{{json .ServerVersion}},"ncpu":{{.NCPU}},"mem_total":{{.MemTotal}}}')" \
      '. + {($engine): {
        socket: $socket,
        context: ($context | if . == "" then null else . end),
        context_endpoint: ($context_host | if . == "" then null else . end),
        arms: ($arms | split(" ")),
        memory_rule: ($memory_rule | if . == "" then null else . end),
        container_ip_reachable_from_host: ($host_ip == 1),
        docker_version: $version,
        docker_info: $info
      }}' <<<"$entries")
  done
  print -r -- "$entries"
}

# Writes meta.json: versions, host, limits, images, commands, load average.
bench_write_meta() {
  local state=$1
  local load_end=null ended=null
  if [[ $state != running ]]; then
    load_end=$(bench_loadavg)
    ended="\"$(bench_utc)\""
  fi
  # Only the engines of this run are asked: a run without apple never touches socktainer or Apple's CLI.
  local colima_version='' orbstack_version='' container_version='' socktainer_version=''
  # The first line of each, taken in zsh: `| head -1` ends the writer with SIGPIPE, which pipefail
  # turns into a failure.
  bench_in_run colima && colima_version=${${(f)"$(colima version 2>&1)"}[1]}
  if bench_in_run orbstack && (( $+commands[orb] )); then
    orbstack_version=${${(f)"$(orb version 2>&1)"}[1]}
  fi
  if bench_in_run apple; then
    container_version=$(container --version 2>&1)
    socktainer_version=${${(f)"$(socktainer --version 2>&1)"}[1]}
  fi
  local dd_hypervisor=null
  if bench_in_docker_desktop; then
    dd_hypervisor=$BENCH_DD_EVIDENCE
  fi
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
    --argjson engines "$(bench_engines_json)" \
    --argjson dd_hypervisor "$dd_hypervisor" \
    --arg colima_version "$colima_version" \
    --arg orbstack_version "$orbstack_version" \
    --arg container_version "$container_version" \
    --arg socktainer_version "$socktainer_version" \
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
    'def orNull: if . == "" then null else . end;
    {
      experiment: $experiment,
      state: $state,
      started_utc: $started,
      ended_utc: $ended,
      interrupted: ($interrupted == 1),
      order: $order,
      limits: {cpus: $cpus, memory: $memory},
      label: $label,
      images: {alpine: $alpine, fio: $fio, sysbench: $sysbench, iperf3: $iperf3},
      engines: $engines,
      docker_desktop_hypervisor: $dd_hypervisor,
      versions: {
        colima: ($colima_version | orNull),
        orbstack: ($orbstack_version | orNull),
        container: ($container_version | orNull),
        socktainer: ($socktainer_version | orNull),
        hyperfine: $hyperfine_version
      },
      host: {macos: $macos, macos_build: $macos_build, model: $model, ncpu: $ncpu, memsize: $memsize},
      loadavg: {start: $load_start, end: $load_end},
      foreign_running_containers_at_start: $foreign,
      notes: $notes,
      commands: ($commands | split("\n") | map(select(length > 0)))
    }' >"$BENCH_OUT/meta.json.tmp"
  mv -- "$BENCH_OUT/meta.json.tmp" "$BENCH_OUT/meta.json"
}

# Removes every container and volume labelled dev.zukhruf.bench=1 on the engines of this run.
# Touches nothing else.
bench_cleanup() {
  local engine ids
  for engine in $(bench_engines); do
    ids=(${(f)"$(dk $engine ps -aq --filter label=$BENCH_LABEL 2>/dev/null)"})
    (( $#ids )) && dk $engine rm -f -v $ids >/dev/null 2>&1
    ids=(${(f)"$(dk $engine volume ls -q --filter label=$BENCH_LABEL 2>/dev/null)"})
    (( $#ids )) && dk $engine volume rm -f $ids >/dev/null 2>&1
  done
  bench_in_run apple || return 0
  # Containers made with Apple's own CLI carry the label in their configuration.
  ids=(${(f)"$(ac list --all --format json 2>/dev/null |
    jq -r --arg k $BENCH_LABEL_KEY '.[] | select(.configuration.labels[$k] == "1") | .id' 2>/dev/null)"})
  (( $#ids )) && ac delete --force $ids >/dev/null 2>&1
  return 0
}

# Cleans up and writes the final meta.json, once. Takes the exit status, or reads $?.
bench_on_exit() {
  local rc=$?
  (( $# )) && rc=$1
  (( BENCH_INITIALIZED )) || return 0
  BENCH_INITIALIZED=0
  setopt localoptions noerrexit
  print -- "cleaning up containers and volumes labelled $BENCH_LABEL"
  bench_cleanup
  local state=failed
  (( rc == 0 )) && state=done
  (( BENCH_INTERRUPTED )) && state=interrupted
  bench_write_meta $state
  print -- "meta: $BENCH_OUT/meta.json"
}

# zsh 5.9 runs neither the EXIT trap nor zshexit when errexit ends the shell inside a function, or
# when a trap calls exit inside one (probe: `setopt errexit; trap "print ran" EXIT; f() { false; }; f`
# prints nothing). So the ZERR trap, which fires where errexit is about to exit, cleans up first;
# only in the main shell, as a $(...) subshell inherits the trap. The signal trap cleans up before
# its exit for the same reason.
trap bench_on_exit EXIT
trap 'BENCH_EXIT_STATUS=$?; (( ZSH_SUBSHELL )) || bench_on_exit $BENCH_EXIT_STATUS' ZERR
trap 'BENCH_INTERRUPTED=1; bench_on_exit 130; exit 130' INT TERM HUP
