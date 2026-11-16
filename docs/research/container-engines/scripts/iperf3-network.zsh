#!/usr/bin/env zsh
# Experiment 8, iperf3-network: TCP throughput with iperf3 -J.
#
# Per slot one iperf3 server container runs (--cpus 2 --memory 1g, port 5201 published on
# 127.0.0.1:<port>). Paths:
#   container-to-container  a client container (same limits) on the engine's default network
#                           connects to the server's container IP
#   host-published          iperf3 on the macOS host connects to 127.0.0.1:<port>
#   host-ip (Apple only)    iperf3 on the macOS host connects to the server's 192.168.64.x IP;
#                           Docker Desktop's container IPs are not reachable from the host
# The host paths need iperf3 on the host (brew install iperf3); without it they are skipped and
# meta.json says so. Each path gets one discarded 3 s warm-up run, then --repeats measured runs.

BENCH_USAGE="usage: iperf3-network.zsh [options] [--time S] [--repeats N] [--port P]

  --time S      Seconds per measured iperf3 run (default 10).
  --repeats N   Measured runs per path per slot (default 3).
  --port P      Host port the server publishes on 127.0.0.1 (default 25201)."

source "${0:A:h}/lib.zsh"
typeset -a opt_time=() opt_repeats=() opt_port=()
zparseopts -D -E -- -time:=opt_time -repeats:=opt_repeats -port:=opt_port
duration=${opt_time[-1]:-10}
repeats=${opt_repeats[-1]:-3}
port=${opt_port[-1]:-25201}
bench_require_positive "--time, --repeats and --port take positive whole numbers" $duration $repeats $port
bench_parse_args "$@"
bench_init iperf3-network
BENCH_NOTES+=(
  "iperf3 -t $duration -J, $repeats runs per path per slot after a discarded 3 s run; TCP, one stream, client sends"
  "server and client containers: --cpus $BENCH_CPUS --memory $BENCH_MEMORY; socktainer's network connect is a no-op, so both containers use the default network"
  "Apple's published-port forwarder drops a connection when the client half-closes; a failed host-published run keeps iperf3's error JSON"
)

host_iperf3=$(command -v iperf3 || true)
if [[ -z $host_iperf3 ]]; then
  print -u2 -- "warning: no iperf3 on the host; the host-published and host-ip paths are skipped (brew install iperf3)"
  BENCH_NOTES+=("host iperf3 missing: host-published and host-ip paths skipped")
else
  BENCH_NOTES+=("host iperf3: $host_iperf3 ($(iperf3 --version | head -1))")
fi

# The server runs with --forceflush: without a TTY iperf3 buffers its stdout, so "Server listening"
# never reaches the logs. The logs are read whole: with pipefail, `logs | grep -q` fails when grep
# exits early and the docker CLI dies of SIGPIPE.
wait_for_server() {
  local engine=$1 name=$2 n
  (( BENCH_DRY_RUN )) && return 0
  for n in {1..30}; do
    [[ $(dk $engine logs $name 2>&1) == *'Server listening'* ]] && return 0
    sleep 1
  done
  bench_fail "the iperf3 server on $engine did not report listening in 30 s"
}

# Runs one route: a discarded warm-up, then the measured runs. The client is a command prefix.
# Not `path`: in zsh that name is the array tied to PATH, and a local of it loses every command.
measure_route() {
  local slot=$1 route=$2
  shift 2
  local -a client=("$@")
  local n
  bench_capture /dev/null $client -t 3 -J || true
  for n in {1..$repeats}; do
    bench_capture "$BENCH_OUT/$slot-$route-$n.json" $client -t $duration -J ||
      print -u2 -- "warning: iperf3 $route run $n failed (exit $?); its JSON is kept"
  done
}

BENCH_CALL_TIMEOUT=$(( duration + 120 ))

measure_slot() {
  local engine=$1 slot=$2
  local server=$BENCH_NAME_PREFIX-iperf3-$slot
  bench_run dk $engine run -d --name $server $BENCH_LIMITS -p 127.0.0.1:$port:5201 $IMAGE_IPERF3 -s --forceflush >/dev/null
  wait_for_server $engine $server
  local ip=$(bench_output dk $engine inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $server)
  [[ -n $ip ]] || bench_die "no IP for the iperf3 server on $engine"
  print -- "   server IP $ip"

  measure_route $slot container-to-container dk $engine run --rm $BENCH_LIMITS $IMAGE_IPERF3 -c $ip
  if [[ -n $host_iperf3 ]]; then
    measure_route $slot host-published gtimeout -s KILL $BENCH_CALL_TIMEOUT iperf3 -c 127.0.0.1 -p $port
    if [[ $engine == apple ]]; then
      measure_route $slot host-ip gtimeout -s KILL $BENCH_CALL_TIMEOUT iperf3 -c $ip
    fi
  fi
  bench_run dk $engine rm -f $server >/dev/null
}

bench_each_slot measure_slot

# A failed run keeps iperf3's error JSON, so a run that measured nothing still writes a file.
# Fail unless at least one run on every route measured a throughput.
if (( ! BENCH_DRY_RUN )); then
  for route in container-to-container ${host_iperf3:+host-published}; do
    files=("$BENCH_OUT"/*-$route-*.json(N))
    (( $#files )) && jq -s -e 'any(.[]; .end.sum_received.bits_per_second > 0)' $files >/dev/null ||
      bench_fail "no iperf3 run on the $route route measured a throughput"
  done
fi
