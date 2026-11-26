import { randomUUID } from 'node:crypto';

import pMemoize, { pMemoizeClear } from 'p-memoize';

import { type Clock, poll, timeout, untilAborted } from '@zukhruf/async';
import {
  BindSourceNotFoundError,
  type Container,
  ContainerNotFoundError,
  ContainerNotRunningError,
  type ContainerProcess,
  type Docker,
  type EngineApi,
  ImageNotFoundError,
  IncompleteOutputError,
  type OutputChunk,
} from '@zukhruf/docker';

import { type Collector, ENDED, KIND_LABEL } from '../databases/collector.ts';
import {
  DATABASE_LABEL,
  DATABASE_SERVER_LABEL,
} from '../databases/database-record.ts';
import { mariadb, mysql } from '../databases/mysql-family-collector.ts';
import { postgres } from '../databases/postgres-collector.ts';
import { sqlserver } from '../databases/sqlserver-collector.ts';
import {
  LEASED_SERVER_LABEL,
  LEASE_IMAGE,
  LEASE_LABEL,
  sweepLeaseName,
} from './engine-lease.ts';
import {
  TEST_RUN_LABEL,
  directoryParent,
  directoryPrefix,
} from './run-records.ts';

/** An official Docker CLI image, pinned (ADR 0020, item 10). */
export const REAPER_IMAGE = 'docker:28.5.2-cli';

/** Marks the reaper of a run, with the run's id. It is not the run's label: the reaper would remove itself. */
export const REAPER_LABEL = 'dev.zukhruf.testing.reaper';

/** Marks a reaper with a value of its own, which it looks for through its socket (ADR 0020, item 14). */
const SELF_LABEL = 'dev.zukhruf.testing.reaper.self';

/** Marks a reaper with the source of its socket on the engine's host (ADR 0020, item 14). */
const SOCKET_LABEL = 'dev.zukhruf.testing.reaper.socket';

/** The path of the engine's socket in a reaper, where its `docker` CLI looks by default. */
const SOCKET = '/var/run/docker.sock';

/** The mount in a reaper of the folder of the engine's host that holds the host directories (ADR 0023). */
const DIRECTORIES = '/directories';

/** Marks a server that `reuse()` shares (ADR 0019). */
export const SERVER_LABEL = 'dev.zukhruf.testing.server';

/** The inputs of a reaper, in milliseconds where they are times (ADR 0020, item 4). */
export interface ReaperSettings {
  /** The wait after the last holder ended, before the first pass. */
  grace: number;
  /** The wait between two passes. */
  interval: number;
  /** The passes after the first one. */
  passes: number;
  /** The time limit of each request to the engine. */
  requestTimeout: number;
  /** The tries of a removal after its first one. */
  retries: number;
  /** The wait for a first holder, after the start. */
  firstHolder: number;
  /** The age from which the reaper removes a shared server that no process lease holds (ADR 0019). */
  serverTtl: number;
  /** The age from which the reaper removes a stopped reaper, such as a kept reaper (ADR 0031). */
  keptTtl: number;
  /** How long the reaper waits for the sweep lease of one server that another holder has (ADR 0014). */
  sweepWait: number;
  /** The tries to take the sweep lease of one server. */
  sweepTries: number;
  /** The time a `created` sweep lease gets to start before the reaper removes it. */
  leasePatience: number;
  /**
   * The readiness bound of a hold: the longest that a process waits for it,
   * with its image pull, create, start, check of the socket and answer
   * (ADR 0020, item 15).
   */
  readiness: number;
}

/** The values of the probe and of Ryuk, and of ADR 0014, ADR 0019 and ADR 0020. */
export const REAPER_DEFAULTS: ReaperSettings = {
  grace: 2_000,
  interval: 1_000,
  passes: 5,
  requestTimeout: 10_000,
  retries: 10,
  firstHolder: 60_000,
  serverTtl: 7 * 24 * 60 * 60 * 1000,
  keptTtl: 7 * 24 * 60 * 60 * 1000,
  sweepWait: 30_000,
  sweepTries: 3,
  leasePatience: 5_000,
  readiness: 60_000,
};

/** The name of the reaper of the run `runId` on an engine: one reaper for each run (ADR 0020, item 7). */
export const reaperName = (runId: string): string =>
  `zukhruf-testing-reaper-${runId}`;

/** The collector of each kind of shared server (ADR 0011). */
const COLLECTORS: readonly Collector[] = [postgres, mysql, mariadb, sqlserver];

/** The lock file of the reaper: a holder holds it shared, and the reaper closes it exclusive (ADR 0020, item 7). */
const DOOR = '/tmp/door';

/**
 * The file of the reaper's check of its socket: `verified` when the socket
 * reaches the reaper's own engine, else the reason why not (ADR 0020, item 14).
 */
const BIND = '/tmp/bind';

/**
 * The mark of a first holder: a holder writes it once it holds the door, so
 * a hold that ended before the reaper looked still ends the wait for a first
 * holder (ADR 0020, item 9).
 */
const CAME = '/tmp/came';

/**
 * The mark of a call that the request time limit ended: the reaper keeps its
 * container at its end, so its logs keep the line of that call (ADR 0031). A
 * restart keeps the mark, as the logs keep the lines of each start.
 */
const LIMITED = '/tmp/limited';

/**
 * The seconds between two keep-alive bytes of a holder (root ADR 0012): the
 * keep-alive idle time and interval of Go, which the connections of Ryuk use.
 * A byte comes at the status of `timeout` at its limit: 124 from GNU
 * `timeout`, and 141 from BusyBox `timeout`, which gives the status of its
 * program, here the SIGPIPE of `head`.
 */
const KEEP_ALIVE_INTERVAL = 15;

/**
 * The exec of a holder. It waits for the check of the reaper's socket, and
 * ends with no answer when its input ends first: its owner went away (#4512).
 * BusyBox `read -t` gives 1 both at a timeout and at the end of the input, so
 * the wait reads with `head`, which a SIGPIPE from `timeout` ends with no
 * message; no owner writes to a holder. Its answer is its first line:
 * `unverified` and the reason when the socket does not reach the reaper's
 * engine, `held` once it holds the door shared and wrote the mark of a first
 * holder, then its `cat` keeps the lock until the hold ends, or `closing` when
 * the reaper closed its door.
 *
 * After `held`, the holder writes one keep-alive byte to its output each
 * KEEP_ALIVE_INTERVAL seconds while its `cat` runs (root ADR 0012). The
 * engine sends each byte to the owner, so the kernel of the engine's host
 * ends the connection of an owner that went away with no close, and `cat`
 * reads the end of its input. `cat` writes to `/dev/null`, and its fd 4 holds
 * the pipe to the writer: the writer's `head` reads the end of that pipe when
 * `cat` ends, and the writer ends. Any other status of `timeout`, such as 127
 * for a missing command, stops the writer, and `cat` still holds. The writer
 * closes the door's fd 8: only `cat` and its shell hold the lock.
 */
const HOLD = [
  'sh',
  '-c',
  `until [ -e ${BIND} ]; do timeout -s PIPE 0.05 head -c 1 > /dev/null && exit 0; done; read -r bind < ${BIND}; [ "$bind" = verified ] || { echo "unverified $bind"; exit 0; }; exec 8>>${DOOR}; flock -n -s 8 || { echo closing; exit 0; }; : > ${CAME}; echo held; cat 4>&1 > /dev/null | { while :; do timeout -s PIPE ${KEEP_ALIVE_INTERVAL} head -c 1 > /dev/null; case $? in 124|141) printf . ;; *) break ;; esac; done; } 8>&-`,
];

/** A word of `sh` in double quotes. Each `\u0000name\u0000` in `text` becomes the variable `name`. */
function word(text: string): string {
  const escaped = text.replaceAll(/[\\"$`]/g, (character) => `\\${character}`);
  return `"${escaped.replaceAll(/\0(\w+)\0/g, (_, name: string) => `\${${name}}`)}"`;
}

const variable = (name: string): string => `\0${name}\0`;

/** The `case` branch of a collector: drops the database `$database` in the server `$1` with the server's own client. */
function dropBranch(collector: Collector): string {
  const { variable: name, fallback } = collector.credential;
  const drop = collector
    .command(variable('credential'), variable('drop'))
    .map((part) => word(part))
    .join(' ');
  return `
    ${collector.kind})
      credential=$(value ${name})
      ${fallback === undefined ? '' : `[ -n "$credential" ] || credential=${word(fallback)}`}
      drop=${word(collector.drop(variable('database')))}
      bounded "docker exec $1 drop $database" "$1" docker exec "$1" ${drop} >/dev/null ;;`;
}

/**
 * The command of the reaper. Each holder is one `cat` exec that holds the
 * door shared. After the last holder ended, it waits the grace, and a holder
 * that comes back stops the countdown. Then it closes the door, removes the
 * run's containers, drops the databases that the run recorded (ADR 0032),
 * removes the run's other volumes and its host directories, does the
 * re-check passes and removes the expired shared servers and the expired
 * stopped reapers, with the door closed. It removes itself, or keeps its
 * container when a call hit its request time limit (ADR 0031).
 */
function script(): string {
  return `
set -u
exec 9>>${DOOR}
# The reaper's own standard error, which the redirection of a call does not reach.
exec 3>&2
# A restart by the engine keeps the files of the last start: a mark of a first
# holder would end the wait for one at once, and an old check of the socket
# would answer a holder before this start checked it (#4508).
rm -f ${CAME} ${BIND}
filter="label=${TEST_RUN_LABEL}=$REAPER_RUN"
tick=0.05
# Milliseconds since boot. Not %d: BusyBox awk caps it at 2^31 - 1 ms, which
# an engine host passes after 24.8 days of uptime; the shell's arithmetic is
# 64-bit.
now() { awk '{ printf "%.0f", $1 * 1000 }' /proc/uptime; }
holders() { pgrep -x cat | wc -l; }
seconds() { awk -v ms="$1" 'BEGIN { print ms / 1000 }'; }
limit=$(seconds "$REAPER_REQUEST_TIMEOUT")
# Runs a call within the request time limit: a watchdog kills the call at the
# limit. A call that the watchdog killed writes one line in the slog text shape
# of Ryuk to the reaper's standard error, with the name $1 of the call and the
# server $2 when it is not empty, and marks the reaper to keep its container
# (ADR 0031). The line names the call and does not copy it: the command of a
# drop holds the credential of its server. The watchdog writes its file before
# its kill, and the exit status 137 says that the kill ended the call. The exit
# status alone is no proof: docker exec also exits 137 when its container is
# removed during the call, and BusyBox timeout gives the status of its program.
bounded() {
  what=$1 server=$2
  shift 2
  "$@" &
  callpid=$!
  fired=/tmp/fired-$callpid
  # The watchdog. Its stop kills its sleep with KILL: a TERM that comes before
  # the exec of the sleep goes to the trap of the shell that forks it, which
  # the exec drops, and that sleep would run to the limit. A stop that comes
  # before the watchdog has the pid of its sleep kills that sleep once it has it.
  (
    stop=
    trap 'stop=1; kill -KILL "\${nap-}" 2>/dev/null' TERM
    sleep "$limit" &
    nap=$!
    [ -z "$stop" ] || kill -KILL "$nap"
    wait "$nap" && [ -z "$stop" ] && : > "$fired" && kill -KILL "$callpid"
    # Reaps the sleep when the trap ended the first wait.
    wait "$nap"
  ) >/dev/null 2>&1 &
  watchdog=$!
  wait "$callpid"
  status=$?
  # With no redirection, the shell writes "Terminated" for the stopped
  # watchdog to the standard error of the call, which a caller can capture.
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  if [ -e "$fired" ] && [ "$status" -eq 137 ]; then
    : > ${LIMITED}
    echo "level=WARN msg=\\"request time limit\\" call=\\"$what\\"\${server:+ server=$server} limit=$REAPER_REQUEST_TIMEOUT run=$REAPER_RUN" >&3
  fi
  rm -f "$fired"
  return "$status"
}
once() { bounded "$1 \${2-}" "" "$@"; }
# Tries a removal, and again REAPER_RETRIES times, one interval apart.
call() {
  attempt=0
  until once "$@"; do
    attempt=$((attempt + 1))
    [ "$attempt" -gt "$REAPER_RETRIES" ] && return 1
    sleep "$(seconds "$REAPER_INTERVAL")"
  done
}
# Waits $1 ms. Fails when a holder comes. It counts the cat processes and
# never tries the lock: a try would refuse a holder that comes in that moment.
quiet() {
  end=$(($(now) + $1))
  while [ "$(now)" -lt "$end" ]; do
    [ "$(holders)" -gt 0 ] && return 1
    sleep $tick
  done
  [ "$(holders)" -eq 0 ]
}
value() { echo "$env" | sed -n "s/^$1=//p" | head -n 1; }

# Drops the database $3 in the server $1 of the kind $2, with the server's own
# client and the credential of its environment.
drop_in() {
  database=$3
  env=$(bounded "docker inspect $1" "$1" docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1") || return 1
  case $2 in${COLLECTORS.map((collector) => dropBranch(collector)).join('')}
  esac
}

# Succeeds when the server $1 is gone or stopped. A shared server runs with
# AutoRemove, so a server that stopped took its databases with it; a paused
# server still holds them.
ended() {
  state=$(once docker ps -a --no-trunc --filter "id=$1" --format '{{.State}}') || return 1
  case $state in ''|${[...ENDED].join('|')}) return 0 ;; esac
  return 1
}

# Drops each database that the run recorded, in its server, and removes the
# record once the drop succeeded or the server ended. A record whose drop
# failed stays, for the next reaper of the run (ADR 0032). No pass visits a
# server that its run did not record.
records() {
  listed=$(call docker volume ls --filter "$filter" --filter "label=${DATABASE_LABEL}" --format '{{.Name}} {{.Label "${DATABASE_LABEL}"}} {{.Label "${DATABASE_SERVER_LABEL}"}} {{.Label "${KIND_LABEL}"}}') || return 1
  echo "$listed" | while read -r record database server kind; do
    [ -n "$record" ] || continue
    drop_in "$server" "$kind" "$database" || ended "$server" || continue
    call docker volume rm "$record" >/dev/null
  done
}

pass() {
  listed=$(call docker ps -a --no-trunc --filter "$filter" --format '{{.ID}} {{.Label "${SERVER_LABEL}"}}') || return 1
  ids=$(echo "$listed" | awk 'NF == 1 { print $1 }')
  [ -z "$ids" ] || call docker rm -f -v $ids >/dev/null || return 1
  records || return 1
  # The run's other volumes: a record has the name of its database as a label.
  listed=$(call docker volume ls --filter "$filter" --format '{{.Name}} {{.Label "${DATABASE_LABEL}"}}') || return 1
  volumes=$(echo "$listed" | awk 'NF == 1 { print $1 }')
  [ -z "$volumes" ] || call docker volume rm -f $volumes >/dev/null || return 1
  return 0
}

# Removes the run's host directories (ADR 0023), after the first pass removed
# the run's containers, which can write to them. chmod first: where the root
# of a container acts as the user of the engine's host, as on the file sharing
# of Docker Desktop, rm cannot enter a folder that a container made 000.
directories() {
  set -- ${DIRECTORIES}/${directoryPrefix('$REAPER_RUN')}*
  [ -e "$1" ] || return 0
  once chmod -R u+rwx "$@"
  once rm -rf "$@"
}

# Resolves when the lease $1 is gone, as EngineLease.gone does; fails at $deadline.
# An inspect that hit its request time limit (bounded's status 137) does not say
# that the lease is gone, so gone() asks again.
gone() {
  seen=
  while :; do
    [ "$(now)" -ge "$deadline" ] && return 1
    state=$(once docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null) || {
      [ $? -eq 137 ] || return 0
      continue
    }
    case $state in exited|dead) once docker rm "$1" >/dev/null 2>&1; return 0 ;; esac
    if [ "$seen" = created ] && [ "$state" = created ]; then
      once docker rm "$1" >/dev/null 2>&1
      return 0
    fi
    seen=$state
    patience=$(($(now) + REAPER_LEASE_PATIENCE))
    while [ "$(now)" -lt "$patience" ]; do
      [ "$(now)" -ge "$deadline" ] && return 1
      once docker inspect "$1" >/dev/null 2>&1 || [ $? -eq 137 ] || return 0
      sleep $tick
    done
  done
}

# Takes the sweep lease of the fingerprint $1: a cat that ends with this reaper.
# The - after the image: socktainer 1.6.1 runs the image's own Cmd when the
# command is empty (#4205).
lease() {
  name="${sweepLeaseName('$1')}"
  fifo=/tmp/lease-$1
  deadline=$(($(now) + REAPER_SWEEP_WAIT))
  tries=0
  while [ "$tries" -lt "$REAPER_SWEEP_TRIES" ]; do
    tries=$((tries + 1))
    rm -f "$fifo" "$fifo.id" "$fifo.err"
    mkfifo "$fifo"
    docker run -i --rm --name "$name" --cidfile "$fifo.id" --label "${LEASE_LABEL}=sweep" --label "${LEASED_SERVER_LABEL}=$1" --entrypoint cat ${LEASE_IMAGE} - < "$fifo" > /dev/null 2> "$fifo.err" &
    job=$!
    exec 9> "$fifo"
    started=$(($(now) + REAPER_REQUEST_TIMEOUT))
    while kill -0 "$job" 2>/dev/null && [ "$(now)" -lt "$started" ]; do
      [ -s "$fifo.id" ] && [ "$(once docker inspect -f '{{.State.Status}}' "$(head -n 1 "$fifo.id")" 2>/dev/null)" = running ] && return 0
      sleep $tick
    done
    exec 9>&-
    wait "$job"
    grep -q Conflict "$fifo.err" || return 1
    gone "$name" || return 1
  done
  return 1
}

sweep() {
  lease "$2" || return 0
  if held=$(once docker ps -q --filter "label=${LEASE_LABEL}=process" --filter "label=${LEASED_SERVER_LABEL}=$2") && [ -z "$held" ]; then
    once docker rm -f -v "$1" >/dev/null 2>&1
  fi
  exec 9>&-
  wait "$job"
}

# Succeeds when the container $1 is older than $2 ms, from its Created time.
expired() {
  created=$(once docker inspect -f '{{.Created}}' "$1") || return 1
  created=\${created%%.*}
  born=$(date -u -D '%Y-%m-%dT%H:%M:%S' -d "\${created%Z}" +%s) || return 1
  [ $((($(date -u +%s) - born) * 1000)) -gt "$2" ]
}

expire() {
  servers=$(once docker ps -a --no-trunc --filter "label=${SERVER_LABEL}" --format '{{.ID}} {{.Label "${SERVER_LABEL}"}}') || return 0
  echo "$servers" | while read -r id fingerprint; do
    [ -n "$fingerprint" ] || continue
    expired "$id" "$REAPER_SERVER_TTL" || continue
    sweep "$id" "$fingerprint"
  done
}

# Removes each stopped reaper that is older than REAPER_KEPT_TTL, such as a
# reaper that kept its container (ADR 0031). With no -f: the engine refuses
# the removal of a reaper that runs.
forget() {
  stopped=$(once docker ps -aq --no-trunc --filter "label=${REAPER_LABEL}" --filter status=exited --filter status=dead) || return 0
  for id in $stopped; do
    expired "$id" "$REAPER_KEPT_TTL" || continue
    once docker rm -v "$id" >/dev/null 2>&1
  done
}

# Starts each reaper of another run that stayed created for longer than its
# creator's start window: one inspect and one start, each within the request
# time limit in that reaper's own environment (ADR 0020, item 13). A reaper
# that is not created is never touched.
revive() {
  stale=$(once docker ps -aq --no-trunc --filter "label=${REAPER_LABEL}" --filter status=created) || return 0
  for id in $stale; do
    env=$(once docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id") || continue
    [ "$(value REAPER_RUN)" != "$REAPER_RUN" ] || continue
    window=$(value REAPER_REQUEST_TIMEOUT)
    [ -n "$window" ] || continue
    created=$(once docker inspect -f '{{.Created}}' "$id") || continue
    created=\${created%%.*}
    born=$(date -u -D '%Y-%m-%dT%H:%M:%S' -d "\${created%Z}" +%s) || continue
    # Whole seconds: the age is at most 1 s more than it reads.
    [ $((($(date -u +%s) - born - 1) * 1000)) -gt $((2 * window)) ] || continue
    once docker start "$id" >/dev/null 2>&1
  done
}

# Looks through the socket for this reaper, by the value of its own label
# (ADR 0020, item 14). A socket that does not answer, or that reaches another
# engine, is not the socket of this reaper's engine. Then the reaper removes
# nothing: it writes why, for a holder to read, and waits for that holder to
# remove it.
if found=$(once docker ps -a -q --filter "label=${SELF_LABEL}=$REAPER_SELF" 2>&1); then
  if [ -n "$found" ]; then bind=verified; else bind="the socket reaches an engine that does not run this reaper"; fi
else
  reason=$(echo "$found" | tail -n 1)
  bind="the socket does not answer: \${reason:-no answer within $REAPER_REQUEST_TIMEOUT ms}"
fi
echo "$bind" > ${BIND}.new && mv ${BIND}.new ${BIND}
if [ "$bind" != verified ]; then
  sleep "$(seconds $((REAPER_FIRST_HOLDER + REAPER_REQUEST_TIMEOUT)))"
  exit 1
fi
# The engine starts the reaper again after a restart of the engine or a kill
# of the reaper (#4508). Only now: a reaper whose socket does not reach its
# engine ends with exit 1 and must not start again.
once docker update --restart unless-stopped "$found" >/dev/null

first=$(($(now) + REAPER_FIRST_HOLDER))
until [ "$(holders)" -gt 0 ] || [ -e ${CAME} ] || [ "$(now)" -ge "$first" ]; do sleep $tick; done
while :; do
  while [ "$(holders)" -gt 0 ]; do sleep $tick; done
  quiet "$REAPER_GRACE" || continue
  # Closes the door: it fails when a holder came, and then the reaper waits
  # again. The lock stays until the exit, so a holder that comes later is
  # refused and holds the next reaper of the run.
  flock -n -x 9 || continue
  pass
  directories
  checked=0
  while [ "$checked" -lt "$REAPER_PASSES" ]; do
    sleep "$(seconds "$REAPER_INTERVAL")"
    checked=$((checked + 1))
    pass
  done
  expire
  forget
  revive
  # A reaper with a call that hit its request time limit keeps its container,
  # stopped, so its logs keep the line of that call (ADR 0031). It ends its
  # restart policy, which would start it again after its exit, and it frees
  # the name of the run's reaper for the next reaper of the run. When one of
  # the two fails, it removes itself.
  if [ -e ${LIMITED} ] && once docker update --restart no "$found" >/dev/null && once docker rename "$found" "${reaperName('$REAPER_RUN')}-$REAPER_SELF" >/dev/null; then
    exit 0
  fi
  # Docker refuses a restart policy on a container with AutoRemove, so the
  # reaper removes itself. When that fails, the engine starts it again after
  # the exit, and it does its passes again.
  call docker rm -f "$found" >/dev/null
  exit 0
done
`;
}

/**
 * The body of the reaper of the run `runId`, with its inputs in its
 * environment and the file `socket` of the engine's host as its socket. The
 * mount is a `bind` mount, so a `socket` that the engine's host does not have
 * fails the create and creates no directory there. It mounts `directories`,
 * the folder of the engine's host that holds the host directories, and the
 * engine creates that folder when its host has none, as the host of an engine
 * that a relay reaches does not: the run's engine objects do not wait for its
 * directories (ADR 0023). It has no restart policy and no AutoRemove: the
 * reaper sets its policy once it verified its socket, and removes itself at
 * its end, or keeps its container (ADR 0031).
 */
export function reaperRequest(
  runId: string,
  settings: ReaperSettings,
  socket: string,
  directories: string,
): EngineApi.ContainerCreateRequest {
  const self = randomUUID();
  return {
    Image: REAPER_IMAGE,
    Entrypoint: ['sh', '-c', script()],
    Cmd: [],
    Env: [
      `REAPER_RUN=${runId}`,
      `REAPER_SELF=${self}`,
      `REAPER_GRACE=${settings.grace}`,
      `REAPER_INTERVAL=${settings.interval}`,
      `REAPER_PASSES=${settings.passes}`,
      `REAPER_REQUEST_TIMEOUT=${settings.requestTimeout}`,
      `REAPER_RETRIES=${settings.retries}`,
      `REAPER_FIRST_HOLDER=${settings.firstHolder}`,
      `REAPER_SERVER_TTL=${settings.serverTtl}`,
      `REAPER_KEPT_TTL=${settings.keptTtl}`,
      `REAPER_SWEEP_WAIT=${settings.sweepWait}`,
      `REAPER_SWEEP_TRIES=${settings.sweepTries}`,
      `REAPER_LEASE_PATIENCE=${settings.leasePatience}`,
    ],
    Labels: {
      [REAPER_LABEL]: runId,
      [SELF_LABEL]: self,
      [SOCKET_LABEL]: socket,
    },
    HostConfig: {
      Mounts: [
        { Type: 'bind', Source: socket, Target: SOCKET },
        {
          Type: 'bind',
          Source: directories,
          Target: DIRECTORIES,
          BindOptions: { CreateMountpoint: true },
        },
      ],
    },
  };
}

/**
 * The sources of the reaper's socket on the engine's host, in the order a
 * hold tries them (ADR 0020, item 14): the socket of the engine's host, and
 * the path of the engine's socket when `endpoint` is a `unix://` host.
 */
function socketSources(endpoint: string): string[] {
  if (!endpoint.startsWith('unix://')) return [SOCKET];
  const own = new URL(endpoint).pathname;
  return own === SOCKET ? [SOCKET] : [SOCKET, own];
}

/**
 * The longest that a reaper can run after it closed its door: its first pass,
 * the removal of the run's host directories (a chmod and a remove, each within
 * `requestTimeout`), its re-check passes, `interval` apart, its expiry pass
 * with one sweep, the removal of one expired stopped reaper, the start of one
 * reaper left `created`, and its removal of itself, which takes longer than
 * the update and the rename of a reaper that keeps its container. A pass
 * makes four removals (the list and the removal of the containers, then of
 * the volumes), each with its first try and `retries` more, `interval` apart
 * and each within `requestTimeout`, and one list of the shared servers. The expiry pass lists the servers and, for one expired
 * server, inspects it, waits `sweepWait` at most for its sweep lease, lists
 * its process leases and removes it. The removal of an expired stopped reaper
 * lists them, inspects one and removes it. The start of a reaper left
 * `created` lists them, inspects one twice and starts it. Each database to
 * drop, each other expired server or stopped reaper and each other reaper to
 * start adds to this, so a hold that waits longer fails.
 */
export function closingTime(settings: ReaperSettings): number {
  const { requestTimeout, retries, interval, passes, sweepWait } = settings;
  const removal = (retries + 1) * requestTimeout + retries * interval;
  const pass = 4 * removal + requestTimeout;
  const expiry = 4 * requestTimeout + sweepWait;
  const forgetting = 3 * requestTimeout;
  const revival = 4 * requestTimeout;
  const directories = 2 * requestTimeout;
  return (
    (passes + 1) * pass +
    directories +
    passes * interval +
    expiry +
    forgetting +
    revival +
    removal
  );
}

/**
 * Resolves when `reaper`, which closed its door, ended: the engine removed it,
 * or it stopped and kept its container (ADR 0031). Its waits keep no process
 * running. Fails after the closing time of the reaper, or with the reason of
 * `signal`.
 */
async function closed(
  docker: Docker,
  reaper: Container,
  settings: ReaperSettings,
  clock: Clock,
  signal: AbortSignal,
): Promise<void> {
  const ms = closingTime(settings);
  const ended = await poll(
    async () => {
      const state = (await docker.containers.inspect(reaper.id, { signal }))
        ?.State?.Status;
      return state === undefined || state === 'exited' || state === 'dead'
        ? true
        : undefined;
    },
    {
      interval: settings.interval,
      signal,
      clock,
      deadline: clock.performance.now() + ms,
      ref: false,
    },
  );
  if (ended === undefined)
    throw new Error(
      `The reaper ${reaper.id} closed and did not end within ${ms} ms`,
    );
}

/** A reaper that runs, and the source of its socket on the engine's host. */
interface RunningReaper {
  container: Container;
  socket: string;
}

/**
 * The reaper of `runId`, created with `socket` as its socket when it does not
 * exist, and started when it did not start. A reaper that the engine starts
 * again by its policy is waited for, one `interval` apart, until it runs.
 * Gives undefined once a reaper that ends is gone: a later call gets a new
 * one. A missing image is pulled. A reaper that ended and stays, for example
 * one that was stopped, is removed here: nobody else removes it. A `socket` that the
 * engine's host does not have rejects with BindSourceNotFoundError. Each
 * call to the engine stops when `signal` aborts.
 */
async function running(
  docker: Docker,
  endpoint: string,
  runId: string,
  settings: ReaperSettings,
  clock: Clock,
  socket: string,
  signal: AbortSignal,
): Promise<RunningReaper | undefined> {
  const request = reaperRequest(
    runId,
    settings,
    socket,
    directoryParent(endpoint),
  );
  const name = reaperName(runId);
  let reaper: Container;
  try {
    ({ container: reaper } = await docker.containers.createOrGet(request, {
      name,
      signal,
    }));
  } catch (error) {
    if (!(error instanceof ImageNotFoundError)) throw error;
    await docker.images.pull(error.image, { signal });
    ({ container: reaper } = await docker.containers.createOrGet(request, {
      name,
      signal,
    }));
  }
  let state: string | undefined;
  let source: string | undefined;
  try {
    const inspected = await reaper.inspect({ signal });
    state = inspected.State?.Status;
    source = inspected.Config?.Labels?.[SOCKET_LABEL];
    if (state === 'created') {
      await reaper.start({ signal });
      state = 'running';
    }
    // A reaper that the engine starts again after a kill or a restart of the
    // engine is `restarting` until it runs: it is not closing (#4508).
    if (state === 'restarting')
      state = await poll(
        async () => {
          const status = (await reaper.inspect({ signal })).State?.Status;
          return status === 'restarting' ? undefined : status;
        },
        { interval: settings.interval, signal, clock, ref: false },
      );
  } catch (error) {
    if (error instanceof ContainerNotFoundError) return undefined;
    throw error;
  }
  if (state === 'running')
    return { container: reaper, socket: source ?? socket };
  if (state === 'exited' || state === 'dead')
    await reaper.remove({ force: true, signal });
  else await closed(docker, reaper, settings, clock, signal);
  return undefined;
}

/** The codes of a connection to the engine that ended under a read: a dead peer. */
const CONNECTION_ENDS = new Set(['ETIMEDOUT', 'EPIPE']);

/** True for an error that ends the output of an exec when its connection ends. */
const connectionEnded = (error: unknown): boolean =>
  error instanceof IncompleteOutputError ||
  (Error.isError(error) &&
    'code' in error &&
    typeof error.code === 'string' &&
    CONNECTION_ENDS.has(error.code));

/** The first line of the standard output, or undefined when the output ended first. */
async function firstLine(
  output: AsyncIterator<OutputChunk>,
): Promise<string | undefined> {
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const chunk = await output.next();
      if (chunk.done === true) return undefined;
      if (chunk.value.stream !== 'stdout') continue;
      text += decoder.decode(chunk.value.data, { stream: true });
      const end = text.indexOf('\n');
      if (end !== -1) return text.slice(0, end);
    }
  } catch (error) {
    if (connectionEnded(error)) return undefined;
    throw error;
  }
}

/** Resolves when the output ends, also when its connection ends. */
async function drained(output: AsyncIterator<OutputChunk>): Promise<void> {
  try {
    while ((await output.next()).done !== true);
  } catch (error) {
    if (!connectionEnded(error)) throw error;
  }
}

/** What the reaper of a run answered a holder. */
type Answer =
  /** The holder holds the door: its `cat` keeps the hold until its input or its output ends. */
  | {
      kind: 'held';
      socket: string;
      holder: ContainerProcess;
      output: AsyncIterator<OutputChunk>;
    }
  /** The reaper verified its socket and closed its door. */
  | { kind: 'closing'; socket: string; reaper: Container }
  /** The reaper ended before it answered. */
  | { kind: 'ended' };

/** The reason in an answer `unverified <reason>` of HOLD. */
const UNVERIFIED = /^unverified (.*)$/;

/**
 * Asks the reaper of `runId` for a hold, and creates it when the run has
 * none on this engine (ADR 0020, item 14). A reaper answers only after it
 * found itself through its socket. A reaper whose socket does not reach its
 * engine is removed, and the next of `sources` is tried. Rejects with an
 * error that names the engine and each source with its result when no source
 * reaches it. Each call to the engine stops when `signal` aborts.
 */
async function answer(
  docker: Docker,
  endpoint: string,
  runId: string,
  settings: ReaperSettings,
  clock: Clock,
  sources: readonly string[],
  signal: AbortSignal,
): Promise<Answer> {
  const results = new Map<string, string>();
  for (;;) {
    const socket = sources.find((source) => !results.has(source));
    if (socket === undefined)
      throw new Error(
        `The reaper ${reaperName(runId)} found no socket of the engine ${endpoint} that reaches that engine: ${[
          ...results,
        ]
          .map(([source, result]) => `${source}: ${result}`)
          .join('; ')}`,
      );
    let reaper;
    try {
      reaper = await running(
        docker,
        endpoint,
        runId,
        settings,
        clock,
        socket,
        signal,
      );
    } catch (error) {
      if (!(error instanceof BindSourceNotFoundError)) throw error;
      results.set(socket, 'the engine’s host has no file at this path');
      continue;
    }
    if (reaper === undefined) return { kind: 'ended' };
    const reply = await ask(reaper.container, signal);
    if (reply === undefined) return { kind: 'ended' };
    const { line, holder, output } = reply;
    if (line === 'held')
      return { kind: 'held', socket: reaper.socket, holder, output };
    if (line === 'closing')
      return {
        kind: 'closing',
        socket: reaper.socket,
        reaper: reaper.container,
      };
    const reason = UNVERIFIED.exec(line)?.[1];
    if (reason === undefined)
      throw new Error(
        `The reaper ${reaperName(runId)} gave an unknown answer: ${line}`,
      );
    // The run's reaper can have another socket than the one asked for, when
    // another process of the run created it first. Both sources are marked,
    // so each round marks one more source, and the loop ends.
    results.set(
      socket,
      reaper.socket === socket
        ? reason
        : `the run's reaper uses the source ${reaper.socket}: ${reason}`,
    );
    results.set(reaper.socket, reason);
    await reaper.container
      .remove({ force: true, signal })
      .catch((error: unknown) => {
        if (!(error instanceof ContainerNotFoundError)) throw error;
      });
  }
}

/**
 * Asks `reaper` for a hold with HOLD, and gives its first line and its exec.
 * Undefined when the reaper ended first. An abort of `signal` before the
 * caller's hold settled ends the exec.
 */
async function ask(
  reaper: Container,
  signal: AbortSignal,
): Promise<
  | {
      line: string;
      holder: ContainerProcess;
      output: AsyncIterator<OutputChunk>;
    }
  | undefined
> {
  let holder;
  try {
    holder = await reaper.spawn(
      { Cmd: HOLD },
      { stdin: true, ref: false, signal },
    );
  } catch (error) {
    // The reaper ended between the inspect and the exec.
    if (
      error instanceof ContainerNotRunningError ||
      error instanceof ContainerNotFoundError
    )
      return undefined;
    throw error;
  }
  const output = holder[Symbol.asyncIterator]();
  const line = await firstLine(output);
  return line === undefined ? undefined : { line, holder, output };
}

/**
 * Runs `hold`, a hold of the reaper of `runId`, within its readiness bound
 * (ADR 0020, item 15). The waits of a hold keep no process running, as its
 * exec does not; the timer of the bound does, unless `ref` is false. Past the
 * bound, the signal of the hold aborts with an error that names the reaper
 * and the bound: each call to the engine of the hold stops, and the hold
 * rejects with that error, also for each caller that joined it.
 */
async function whileHeld(
  hold: (signal: AbortSignal) => Promise<void>,
  runId: string,
  settings: ReaperSettings,
  clock: Clock,
  ref: boolean,
): Promise<void> {
  using limit = timeout(settings.readiness, { clock, ref });
  const bound = new AbortController();
  limit.signal.addEventListener(
    'abort',
    () =>
      bound.abort(
        new Error(
          `The hold of the reaper ${reaperName(runId)} was not ready within its readiness bound of ${settings.readiness} ms`,
          { cause: limit.signal.reason },
        ),
      ),
    { once: true },
  );
  await untilAborted(hold(bound.signal), bound.signal);
}

/**
 * The hold of this process on the reaper of its run: one `cat` exec with
 * `ref: false` that holds the door of the reaper (ADR 0020, item 7). It ends
 * when this process exits, for any reason. When it ends while this process
 * lives, it is taken again at once: on the same reaper, or on the next one
 * when that reaper closed. The source of the socket of the first reaper that
 * it held is tried first for each next reaper (item 14).
 */
export class ReaperHold {
  readonly #docker: Docker;
  /** The engine as the run names it: an ssh:// engine whose client reaches it at the run's docker.sock (ADR 0024). */
  readonly #endpoint: string;
  readonly #runId: string;
  readonly #settings: ReaperSettings;
  readonly #clock: Clock;
  /** The sources of the reaper's socket, in the order a hold tries them: the source of the last reaper that answered comes first. */
  #sources: readonly string[];

  private constructor(
    docker: Docker,
    endpoint: string,
    runId: string,
    settings: ReaperSettings,
    clock: Clock,
  ) {
    this.#docker = docker;
    this.#endpoint = endpoint;
    this.#runId = runId;
    this.#settings = settings;
    this.#clock = clock;
    this.#sources = socketSources(endpoint);
  }

  /**
   * Holds the reaper of `runId`, and creates it when the run has none on this
   * engine. A reaper that closed is waited for until the engine removed it,
   * and one that ends while the hold starts is tried again: at most
   * `settings.retries` more times. `endpoint` is the engine as the run names
   * it, which decides the reaper's socket and its host directories.
   */
  static async take(
    docker: Docker,
    endpoint: string,
    runId: string,
    settings: ReaperSettings,
    clock: Clock,
  ): Promise<ReaperHold> {
    const hold = new ReaperHold(docker, endpoint, runId, settings, clock);
    await hold.held();
    return hold;
  }

  /**
   * Resolves when this process holds the reaper: at once while the hold
   * lasts, and after the new hold when it ended. A hold that failed is tried
   * again by the next call.
   */
  async held(): Promise<void> {
    await whileHeld(
      (signal) => this.#hold(signal),
      this.#runId,
      this.#settings,
      this.#clock,
      true,
    );
  }

  /**
   * The hold, once at a time: it is cleared when the hold ends, and a failed
   * one is not kept. A call while one runs waits for that one, which stops at
   * the signal of the call that started it.
   */
  readonly #hold = pMemoize(
    async (signal: AbortSignal): Promise<void> => {
      const { retries } = this.#settings;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const reply = await answer(
          this.#docker,
          this.#endpoint,
          this.#runId,
          this.#settings,
          this.#clock,
          this.#sources,
          signal,
        );
        if (reply.kind === 'ended') continue;
        const { socket } = reply;
        this.#sources = [
          socket,
          ...this.#sources.filter((source) => source !== socket),
        ];
        if (reply.kind === 'held') {
          void this.#watch(reply.output);
          return;
        }
        await closed(
          this.#docker,
          reply.reaper,
          this.#settings,
          this.#clock,
          signal,
        );
      }
      throw new Error(
        `The reaper ${reaperName(this.#runId)} ended or closed on each of ${retries + 1} tries to hold it`,
      );
    },
    { cacheKey: () => 'hold' },
  );

  /**
   * Takes the hold again at once when its output ends while this process
   * lives, within its readiness bound, and again each `interval` until it
   * holds: the engine can be away, as at its restart (#4508). Its timers keep
   * no process running. A held() in the meantime joins the hold that runs, and
   * rejects with its failure.
   */
  async #watch(output: AsyncIterator<OutputChunk>): Promise<void> {
    await drained(output);
    pMemoizeClear(this.#hold);
    await poll(
      async () => {
        try {
          await whileHeld(
            (signal) => this.#hold(signal),
            this.#runId,
            this.#settings,
            this.#clock,
            false,
          );
          return true;
        } catch {
          // The watch has no caller: held() reports a failure of the hold.
          return undefined;
        }
      },
      {
        interval: this.#settings.interval,
        signal: undefined,
        clock: this.#clock,
        ref: false,
      },
    );
  }
}
