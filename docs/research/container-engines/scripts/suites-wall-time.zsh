#!/usr/bin/env zsh
# Experiment 4, suites-wall-time: wall time of the repo's Docker-backed test suites per engine,
# the deciding criterion; a red suite is a criterion-2 finding.
#
# The suites pick their engine as the Docker CLI does: DOCKER_HOST, then DOCKER_CONTEXT, then
# currentContext (@zukhruf/docker's context store; packages/testing's global setup resolves the
# context once and hands DOCKER_HOST to the test processes). So each run sets DOCKER_CONTEXT to
# the engine's context from the engine table and unsets DOCKER_HOST; the current context is never
# changed. The script checks that each context's endpoint is the engine's socket.
#
# Steps: one build of the projects (nx run-many -t build), then one unmeasured warm-up run per
# engine and project (it pulls images and creates the shared database servers), then per project
# the measured runs over the engine order, A,B,A,B. Each measured run waits for a quiet Mac first:
# 1-minute load average below --max-load and no other `node --test` process, polled every 15 s for
# up to --max-wait minutes; a run that never gets one is recorded as skipped: busy.
#
# Each run is `nx run <project>:test --skip-sync --skip-nx-cache --excludeTaskDependencies` under
# gtimeout, timed with $EPOCHREALTIME. Per run: <label>.log, <label>-test-results.xml (the
# project's junit file, copied), and one line in runs.jsonl (engine, project, wall seconds, nx exit
# code, junit testcases/failures/skipped, load at start and end, git HEAD and the project's
# `git status --porcelain`), which meta.json also carries as `runs`. A run with failures is kept
# and reported, never retried. A run that leaves no fresh junit file fails the experiment at the end.

BENCH_USAGE="usage: suites-wall-time.zsh [options] [--projects a,b] [--max-load L] [--max-wait M] [--cap M]

Times 'nx run <project>:test' on each engine, A,B,A,B per project, after a build and one warm-up
run per engine and project. Default --interleave for this script: 3.
  --projects a,b  The nx projects (default docker,mutex,testing).
  --max-load L    Wait before each measured run until the 1-minute load average is below L (default 8).
  --max-wait M    Minutes to wait for that before the run is skipped as busy (default 20).
  --cap M         Minutes before gtimeout stops one nx run (default 40)."

source "${0:A:h}/lib.zsh"
zmodload zsh/stat
typeset -a opt_projects=() opt_max_load=() opt_max_wait=() opt_cap=()
zparseopts -D -E -- -projects:=opt_projects -max-load:=opt_max_load -max-wait:=opt_max_wait -cap:=opt_cap
typeset -a projects=(${(s:,:)${opt_projects[-1]:-docker,mutex,testing}})
max_load=${opt_max_load[-1]:-8}
max_wait=${opt_max_wait[-1]:-20}
cap=${opt_cap[-1]:-40}
[[ $max_load == <->(.<->|) ]] || bench_die "--max-load takes a number"
bench_require_positive "--max-wait and --cap take positive whole numbers of minutes" $max_wait $cap
(( $#projects )) || bench_die "--projects names no project"
typeset -gr REPO=${BENCH_RESEARCH_DIR:h:h:h}
for project in $projects; do
  [[ -f $REPO/packages/$project/project.json ]] || bench_die "no project packages/$project in $REPO"
done
# This experiment's default is 3 rounds, not lib's 2.
(( ${@[(I)--interleave*]} || ${@[(I)--engine]} )) || set -- "$@" --interleave 3
bench_parse_args "$@"
for engine in $(bench_engines); do
  [[ -n $BENCH_CONTEXT[$engine] ]] ||
    bench_die "$engine has no docker context in the engine table; the suites select their engine through DOCKER_CONTEXT"
done
bench_init suites-wall-time
cd -- "$REPO"
if (( ! BENCH_DRY_RUN )); then
  for engine in $(bench_engines); do
    endpoint=$(gtimeout -s KILL 30 docker context inspect $BENCH_CONTEXT[$engine] --format '{{.Endpoints.docker.Host}}')
    [[ $endpoint == $BENCH_SOCKET[$engine] ]] ||
      bench_die "context $BENCH_CONTEXT[$engine] points at $endpoint, not at the $engine socket $BENCH_SOCKET[$engine]"
  done
fi

BENCH_NOTES+=(
  "projects: ${(j:,:)projects}; each run: DOCKER_CONTEXT=<engine context>, DOCKER_HOST unset, NX_DAEMON=false, nx run <project>:test --skip-sync --skip-nx-cache --excludeTaskDependencies, under gtimeout -k 30 ${cap}m"
  "one warm-up run per engine and project before the measured runs (kind warmup in runs); measured runs per project in the order ${BENCH_ORDER[*]}"
  "quiet gate before each measured run: 1-minute load average below $max_load and no other 'node --test' process, polled every 15 s for up to $max_wait min, else the run is skipped: busy"
  "wall_s is \$EPOCHREALTIME around the whole nx command (nx start, the test run, teardown); junit counts are grep -a -c of <testcase, <failure and <skipped in the run's copy of packages/<project>/test-results.xml"
  "other sessions share this checkout: each run records git HEAD and git status --porcelain of its project"
)

# The lib writes meta.json; this experiment adds its build and the runs to it.
typeset -g build_json=null
functions[bench_write_meta_lib]=$functions[bench_write_meta]
bench_write_meta() {
  bench_write_meta_lib "$@"
  local runs=$BENCH_OUT/runs.jsonl
  [[ -f $runs ]] || : >"$runs"
  jq --slurpfile runs "$runs" --argjson build "$build_json" \
    --argjson projects "$(print -l -- $projects | jq -R . | jq -s .)" \
    '. + {projects: $projects, build: $build, runs: $runs}' "$BENCH_OUT/meta.json" >"$BENCH_OUT/meta.json.tmp"
  mv -- "$BENCH_OUT/meta.json.tmp" "$BENCH_OUT/meta.json"
}

typeset -ga missing_junit=() red_runs=() odd_exits=()

load1() {
  local -a parts=(${=$(sysctl -n vm.loadavg)})
  print -r -- $parts[2]
}

# Other test runs on the Mac: their containers and CPU are noise, and a run of the same project
# writes the same junit file.
other_tests() {
  local -a lines=(${(f)"$(ps -axo command=)"})
  print -r -- ${#${(M)lines:#*node --test *}}
}

# Waits for a quiet Mac. Returns 1 when none came within --max-wait minutes.
quiet_gate() {
  if (( BENCH_DRY_RUN )); then
    print -u2 -- "[dry-run] quiet gate: load1 < $max_load and no other 'node --test', every 15 s, up to ${max_wait} min"
    return 0
  fi
  local deadline=$(( EPOCHSECONDS + max_wait * 60 )) load others
  while true; do
    load=$(load1) others=$(other_tests)
    if (( load < max_load && others == 0 )); then
      return 0
    fi
    if (( EPOCHSECONDS + 15 > deadline )); then
      print -- "   still busy after ${max_wait} min: load $load, $others other test process(es)"
      return 1
    fi
    print -- "   waiting for a quiet Mac: load $load, $others other test process(es)"
    sleep 15
  done
}

# One line of runs.jsonl.
record() {
  jq -nc "$@" >>"$BENCH_OUT/runs.jsonl"
}

# Runs <project>:test on <engine> once, as <label> of <kind> (warmup or measured), and records it.
run_suite() {
  local engine=$1 project=$2 label=$3 kind=$4
  local context=$BENCH_CONTEXT[$engine]
  local junit=$REPO/packages/$project/test-results.xml
  local log=$BENCH_OUT/$label.log copy=$BENCH_OUT/$label-test-results.xml
  local -a cmd=(gtimeout -k 30 $(( cap * 60 )) env -u DOCKER_HOST DOCKER_CONTEXT=$context NX_DAEMON=false
    npx nx run ${project}:test --skip-sync --skip-nx-cache --excludeTaskDependencies)
  print -- "== $label ($kind): $project on $engine"
  bench_log_line "${(j: :)${(@q-)cmd}} > ${(q-)log} 2>&1"
  (( BENCH_DRY_RUN )) && return 0
  local head=$(git rev-parse HEAD)
  local porcelain=$(git status --porcelain -- packages/$project)
  local started=$(bench_utc) load_start=$(bench_loadavg) begin_s=$EPOCHSECONDS
  local begin=$EPOCHREALTIME rc=0
  $cmd >"$log" 2>&1 || rc=$?
  local end=$EPOCHREALTIME
  local wall=$(printf '%.3f' $(( end - begin )))
  local load_end=$(bench_loadavg)
  local testcases=null failures=null skipped_tests=null have_junit=false
  local -a mtime=()
  [[ -f $junit ]] && zstat -A mtime +mtime -- "$junit"
  if (( $#mtime )) && (( mtime[1] >= begin_s )) && [[ -s $junit ]]; then
    cp -- "$junit" "$copy"
    have_junit=true
    testcases=$(grep -a -c '<testcase' "$copy" || true)
    failures=$(grep -a -c '<failure' "$copy" || true)
    skipped_tests=$(grep -a -c '<skipped' "$copy" || true)
  else
    missing_junit+=($label)
  fi
  record --arg label $label --arg kind $kind --arg engine $engine --arg context $context \
    --arg project $project --arg started "$started" --argjson wall $wall --argjson exit $rc \
    --argjson timed_out $(( rc == 124 || rc == 137 ? 1 : 0 )) \
    --argjson junit $have_junit --argjson testcases $testcases --argjson failures $failures \
    --argjson skipped_tests $skipped_tests --argjson load_start "$load_start" --argjson load_end "$load_end" \
    --arg head $head --arg porcelain "$porcelain" \
    '{label: $label, kind: $kind, engine: $engine, context: $context, project: $project,
      started_utc: $started, wall_s: $wall, exit: $exit, timed_out: ($timed_out == 1),
      junit: $junit, testcases: $testcases, failures: $failures, skipped_tests: $skipped_tests,
      skipped: null, loadavg: {start: $load_start, end: $load_end},
      git: {head: $head, status_porcelain: ($porcelain | split("\n") | map(select(length > 0)))}}'
  print -- "   ${wall}s, exit $rc, testcases $testcases, failures $failures, skipped $skipped_tests"
  if [[ $failures != null ]] && (( failures > 0 )); then
    red_runs+=("$label: $failures failure(s)")
  elif (( rc != 0 )); then
    odd_exits+=("$label: exit $rc with no junit failure")
  fi
  return 0
}

# Build once; the measured runs exclude the build tasks.
build_cmd=(env NX_DAEMON=false npx nx run-many -t build -p ${(j:,:)projects} --skip-sync)
print -- "== build: ${(j:,:)projects}"
bench_log_line "${(j: :)${(@q-)build_cmd}} > ${(q-)BENCH_OUT}/build.log 2>&1"
if (( ! BENCH_DRY_RUN )); then
  build_begin=$EPOCHREALTIME build_rc=0
  $build_cmd >"$BENCH_OUT/build.log" 2>&1 || build_rc=$?
  build_json=$(jq -nc --argjson exit $build_rc --argjson wall $(printf '%.3f' $(( EPOCHREALTIME - build_begin ))) \
    '{exit: $exit, wall_s: $wall, log: "build.log"}')
  (( build_rc == 0 )) || bench_fail "the build failed (exit $build_rc); see $BENCH_OUT/build.log"
fi

for project in $projects; do
  for engine in $(bench_engines); do
    run_suite $engine $project warmup-$engine-$project warmup
  done
done

for project in $projects; do
  for i in {1..$#BENCH_ORDER}; do
    engine=$BENCH_ORDER[$i]
    label=$(bench_slot $i)-$project
    if quiet_gate; then
      run_suite $engine $project $label measured
    else
      print -- "== $label (measured): skipped, busy"
      record --arg label $label --arg engine $engine --arg project $project \
        --arg started "$(bench_utc)" --argjson load "$(bench_loadavg)" --argjson others "$(other_tests)" \
        '{label: $label, kind: "measured", engine: $engine, project: $project, started_utc: $started,
          skipped: "busy", loadavg: {start: $load, end: null}, other_test_processes: $others}'
    fi
  done
done

(( BENCH_DRY_RUN )) && exit 0

jq -rs '
  def median: sort | length as $n | if $n == 0 then null
    elif $n % 2 == 1 then .[($n - 1) / 2] else (.[$n / 2 - 1] + .[$n / 2]) / 2 end;
  (["engine", "project", "n", "median_s", "min_s", "max_s", "failures_total", "skipped_busy"] | @tsv),
  (map(select(.kind == "measured")) | group_by([.project, .engine]) | .[]
    | (map(select(.skipped == null))) as $ran | ($ran | map(.wall_s)) as $w
    | [.[0].engine, .[0].project, ($w | length), ($w | median), ($w | min), ($w | max),
       ($ran | map(.failures // 0) | add // 0), (map(select(.skipped == "busy")) | length)] | @tsv)
' "$BENCH_OUT/runs.jsonl" >"$BENCH_OUT/summary.tsv"
print -- "summary: $BENCH_OUT/summary.tsv"
column -t -s $'\t' "$BENCH_OUT/summary.tsv"

for line in $red_runs; do print -u2 -- "CRITERION 2 (red suite): $line"; done
for line in $odd_exits; do print -u2 -- "warning: $line; see its log"; done
(( $#missing_junit == 0 )) ||
  bench_fail "no fresh junit file from: ${(j:, :)missing_junit} (packages/<project>/test-results.xml was missing or older than the run)"
(( $(wc -l <"$BENCH_OUT/summary.tsv") > 1 )) || bench_fail "summary.tsv lists no measured run"
