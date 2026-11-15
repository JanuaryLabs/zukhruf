import pMemoize, { pMemoizeClear } from 'p-memoize';

import { type Clock, poll, timeout, untilAborted } from '@zukhruf/async';
import {
  type Container,
  ContainerNotFoundError,
  ContainerNotRunningError,
  type Docker,
  type EngineApi,
  ImageNotFoundError,
  IncompleteOutputError,
  type OutputChunk,
} from '@zukhruf/docker';

import {
  type Collector,
  KIND_LABEL,
  ownedNames,
} from '../databases/collector.ts';
import { mariadb, mysql } from '../databases/mysql-family-collector.ts';
import { postgres } from '../databases/postgres-collector.ts';
import { sqlserver } from '../databases/sqlserver-collector.ts';
import {
  LEASED_SERVER_LABEL,
  LEASE_IMAGE,
  LEASE_LABEL,
  sweepLeaseName,
} from './engine-lease.ts';
import { TEST_RUN_LABEL } from './run-records.ts';

/** An official Docker CLI image, pinned (ADR 0020, item 10). */
export const REAPER_IMAGE = 'docker:28.5.2-cli';

/** Marks the reaper of a run, with the run's id. It is not the run's label: the reaper would remove itself. */
export const REAPER_LABEL = 'dev.zukhruf.testing.reaper';

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
  /** How long the reaper waits for the sweep lease of one server that another holder has (ADR 0014). */
  sweepWait: number;
  /** The tries to take the sweep lease of one server. */
  sweepTries: number;
  /** The time a `created` sweep lease gets to start before the reaper removes it. */
  leasePatience: number;
}

/** The values of the probe and of Ryuk, and of ADR 0014 and ADR 0019. */
export const REAPER_DEFAULTS: ReaperSettings = {
  grace: 2_000,
  interval: 1_000,
  passes: 5,
  requestTimeout: 10_000,
  retries: 10,
  firstHolder: 60_000,
  serverTtl: 7 * 24 * 60 * 60 * 1000,
  sweepWait: 30_000,
  sweepTries: 3,
  leasePatience: 5_000,
};

/** The name of the reaper of the run `runId` on an engine: one reaper for each run (ADR 0020, item 7). */
export const reaperName = (runId: string): string =>
  `zukhruf-testing-reaper-${runId}`;

/** The collector of each kind of shared server (ADR 0011). */
const COLLECTORS: readonly Collector[] = [postgres, mysql, mariadb, sqlserver];

/** The lock file of the reaper: a holder holds it shared, and the reaper closes it exclusive (ADR 0020, item 7). */
const DOOR = '/tmp/door';

/**
 * The exec of a holder. Its answer is its first line: `held` once it holds
 * the door shared, then its `cat` keeps the lock until the hold ends, or
 * `closing` when the reaper closed its door.
 */
const HOLD = [
  'sh',
  '-c',
  `exec 8>>${DOOR}; flock -n -s 8 || { echo closing; exit 0; }; echo held; exec cat`,
];

/** A word of `sh` in double quotes. Each `\u0000name\u0000` in `text` becomes the variable `name`. */
function word(text: string): string {
  const escaped = text.replaceAll(/[\\"$`]/g, (character) => `\\${character}`);
  return `"${escaped.replaceAll(/\0(\w+)\0/g, (_, name: string) => `\${${name}}`)}"`;
}

const variable = (name: string): string => `\0${name}\0`;

/** The `case` branch of a collector: lists the run's databases on the server `$1` and drops each one. */
function dropBranch(collector: Collector): string {
  const { variable: name, fallback } = collector.credential;
  const run = (sql: string) =>
    collector
      .command(variable('credential'), variable(sql))
      .map((part) => word(part))
      .join(' ');
  return `
    ${collector.kind})
      credential=$(value ${name})
      ${fallback === undefined ? '' : `[ -n "$credential" ] || credential=${word(fallback)}`}
      list=${word(collector.list)}
      names=$(once docker exec "$1" ${run('list')}) || return 0
      for name in $(echo "$names" | tr -d '\\r' | grep -E ${word(ownedNames(variable('hex')))}); do
        drop=${word(collector.drop(variable('name')))}
        once docker exec "$1" ${run('drop')} >/dev/null || return 0
      done ;;`;
}

/**
 * The command of the reaper. Each holder is one `cat` exec that holds the
 * door shared. After the last holder ended, it waits the grace, and a holder
 * that comes back stops the countdown. Then it closes the door, removes the
 * run's containers and volumes, drops the run's databases, does the re-check
 * passes and removes the expired shared servers, with the door closed.
 */
function script(): string {
  return `
set -u
exec 9>>${DOOR}
filter="label=${TEST_RUN_LABEL}=$REAPER_RUN"
hex=$(echo "$REAPER_RUN" | tr -d -)
tick=0.05
# Milliseconds since boot. Not %d: BusyBox awk caps it at 2^31 - 1 ms, which
# an engine host passes after 24.8 days of uptime; the shell's arithmetic is
# 64-bit.
now() { awk '{ printf "%.0f", $1 * 1000 }' /proc/uptime; }
holders() { pgrep -x cat | wc -l; }
seconds() { awk -v ms="$1" 'BEGIN { print ms / 1000 }'; }
limit=$(seconds "$REAPER_REQUEST_TIMEOUT")
once() { timeout -s KILL "$limit" "$@"; }
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

drop_in() {
  env=$(once docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1") || return 0
  case $2 in${COLLECTORS.map((collector) => dropBranch(collector)).join('')}
  esac
}

pass() {
  listed=$(call docker ps -a --no-trunc --filter "$filter" --format '{{.ID}} {{.Label "${SERVER_LABEL}"}}') || return 1
  ids=$(echo "$listed" | awk 'NF == 1 { print $1 }')
  [ -z "$ids" ] || call docker rm -f -v $ids >/dev/null || return 1
  volumes=$(call docker volume ls -q --filter "$filter") || return 1
  [ -z "$volumes" ] || call docker volume rm -f $volumes >/dev/null || return 1
  servers=$(once docker ps --no-trunc --filter "label=${SERVER_LABEL}" --filter "label=${KIND_LABEL}" --format '{{.ID}} {{.Label "${KIND_LABEL}"}}') || return 0
  echo "$servers" | while read -r id kind; do
    [ -n "$id" ] && drop_in "$id" "$kind"
  done
  return 0
}

# Resolves when the lease $1 is gone, as EngineLease.gone does; fails at $deadline.
gone() {
  seen=
  while :; do
    state=$(once docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null) || return 0
    case $state in exited|dead) once docker rm "$1" >/dev/null 2>&1; return 0 ;; esac
    if [ "$seen" = created ] && [ "$state" = created ]; then
      once docker rm "$1" >/dev/null 2>&1
      return 0
    fi
    seen=$state
    patience=$(($(now) + REAPER_LEASE_PATIENCE))
    while [ "$(now)" -lt "$patience" ]; do
      [ "$(now)" -ge "$deadline" ] && return 1
      once docker inspect "$1" >/dev/null 2>&1 || return 0
      sleep $tick
    done
  done
}

# Takes the sweep lease of the fingerprint $1: a cat that ends with this reaper.
lease() {
  name="${sweepLeaseName('$1')}"
  fifo=/tmp/lease-$1
  deadline=$(($(now) + REAPER_SWEEP_WAIT))
  tries=0
  while [ "$tries" -lt "$REAPER_SWEEP_TRIES" ]; do
    tries=$((tries + 1))
    rm -f "$fifo" "$fifo.id" "$fifo.err"
    mkfifo "$fifo"
    docker run -i --rm --name "$name" --cidfile "$fifo.id" --label "${LEASE_LABEL}=sweep" --label "${LEASED_SERVER_LABEL}=$1" --entrypoint cat ${LEASE_IMAGE} < "$fifo" > /dev/null 2> "$fifo.err" &
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

expire() {
  servers=$(once docker ps -a --no-trunc --filter "label=${SERVER_LABEL}" --format '{{.ID}} {{.Label "${SERVER_LABEL}"}}') || return 0
  echo "$servers" | while read -r id fingerprint; do
    [ -n "$fingerprint" ] || continue
    created=$(once docker inspect -f '{{.Created}}' "$id") || continue
    created=\${created%%.*}
    born=$(date -u -D '%Y-%m-%dT%H:%M:%S' -d "\${created%Z}" +%s) || continue
    [ $((($(date -u +%s) - born) * 1000)) -gt "$REAPER_SERVER_TTL" ] || continue
    sweep "$id" "$fingerprint"
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

first=$(($(now) + REAPER_FIRST_HOLDER))
until [ "$(holders)" -gt 0 ] || [ "$(now)" -ge "$first" ]; do sleep $tick; done
while :; do
  while [ "$(holders)" -gt 0 ]; do sleep $tick; done
  quiet "$REAPER_GRACE" || continue
  # Closes the door: it fails when a holder came, and then the reaper waits
  # again. The lock stays until the exit, so a holder that comes later is
  # refused and holds the next reaper of the run.
  flock -n -x 9 || continue
  pass
  checked=0
  while [ "$checked" -lt "$REAPER_PASSES" ]; do
    sleep "$(seconds "$REAPER_INTERVAL")"
    checked=$((checked + 1))
    pass
  done
  expire
  revive
  exit 0
done
`;
}

/** The body of the reaper of the run `runId`, with its inputs in its environment. */
export function reaperRequest(
  runId: string,
  settings: ReaperSettings,
): EngineApi.ContainerCreateRequest {
  return {
    Image: REAPER_IMAGE,
    Entrypoint: ['sh', '-c', script()],
    Cmd: [],
    Env: [
      `REAPER_RUN=${runId}`,
      `REAPER_GRACE=${settings.grace}`,
      `REAPER_INTERVAL=${settings.interval}`,
      `REAPER_PASSES=${settings.passes}`,
      `REAPER_REQUEST_TIMEOUT=${settings.requestTimeout}`,
      `REAPER_RETRIES=${settings.retries}`,
      `REAPER_FIRST_HOLDER=${settings.firstHolder}`,
      `REAPER_SERVER_TTL=${settings.serverTtl}`,
      `REAPER_SWEEP_WAIT=${settings.sweepWait}`,
      `REAPER_SWEEP_TRIES=${settings.sweepTries}`,
      `REAPER_LEASE_PATIENCE=${settings.leasePatience}`,
    ],
    Labels: { [REAPER_LABEL]: runId },
    HostConfig: {
      AutoRemove: true,
      Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
    },
  };
}

/**
 * The longest that a reaper can run after it closed its door: its first pass
 * and its re-check passes, `interval` apart, its expiry pass with one sweep,
 * and the start of one reaper left `created`. A pass makes four removals (the list and the removal of the
 * containers, then of the volumes), each with its first try and `retries`
 * more, `interval` apart and each within `requestTimeout`, and one list of the
 * shared servers. The expiry pass lists the servers and, for one expired
 * server, inspects it, waits `sweepWait` at most for its sweep lease, lists
 * its process leases and removes it. The start of a reaper left `created`
 * lists them, inspects one twice and starts it. Each database to drop, each
 * other expired server and each other reaper to start adds to this, so a hold
 * that waits longer fails.
 */
export function closingTime(settings: ReaperSettings): number {
  const { requestTimeout, retries, interval, passes, sweepWait } = settings;
  const removal = (retries + 1) * requestTimeout + retries * interval;
  const pass = 4 * removal + requestTimeout;
  const expiry = 4 * requestTimeout + sweepWait;
  const revival = 4 * requestTimeout;
  return (passes + 1) * pass + passes * interval + expiry + revival;
}

/**
 * Resolves when the engine removed `reaper`, which closed its door. Its waits
 * keep no process running. Fails after the closing time of the reaper.
 */
async function closed(
  docker: Docker,
  reaper: Container,
  settings: ReaperSettings,
  clock: Clock,
): Promise<void> {
  const ms = closingTime(settings);
  const removed = await poll(
    async () =>
      (await docker.containers.find(reaper.id)) === undefined
        ? true
        : undefined,
    {
      interval: settings.interval,
      signal: undefined,
      clock,
      deadline: clock.performance.now() + ms,
      ref: false,
    },
  );
  if (removed === undefined)
    throw new Error(
      `The reaper ${reaper.id} closed and was not removed within ${ms} ms`,
    );
}

/**
 * The reaper of `runId`, created when it does not exist, and started when it
 * did not start. Gives undefined once a reaper that ends is gone: a later call
 * gets a new one. A missing image is pulled. A reaper that ended and stays,
 * for example one whose removal by the engine failed, is removed here: nobody
 * else removes it.
 */
async function running(
  docker: Docker,
  runId: string,
  settings: ReaperSettings,
  clock: Clock,
): Promise<Container | undefined> {
  const request = reaperRequest(runId, settings);
  const name = reaperName(runId);
  let reaper: Container;
  try {
    ({ container: reaper } = await docker.containers.createOrGet(request, {
      name,
    }));
  } catch (error) {
    if (!(error instanceof ImageNotFoundError)) throw error;
    await docker.images.pull(error.image);
    ({ container: reaper } = await docker.containers.createOrGet(request, {
      name,
    }));
  }
  let state: string | undefined;
  try {
    state = (await reaper.inspect()).State?.Status;
    if (state === 'created') {
      await reaper.start();
      state = 'running';
    }
  } catch (error) {
    if (error instanceof ContainerNotFoundError) return undefined;
    throw error;
  }
  if (state === 'running') return reaper;
  if (state === 'exited' || state === 'dead')
    await reaper.remove({ force: true });
  else await closed(docker, reaper, settings, clock);
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

/**
 * The hold of this process on the reaper of its run: one `cat` exec with
 * `ref: false` that holds the door of the reaper (ADR 0020, item 7). It ends
 * when this process exits, for any reason. When it ends while this process
 * lives, it is taken again at once: on the same reaper, or on the next one
 * when that reaper closed.
 */
export class ReaperHold {
  readonly #docker: Docker;
  readonly #runId: string;
  readonly #settings: ReaperSettings;
  readonly #clock: Clock;

  private constructor(
    docker: Docker,
    runId: string,
    settings: ReaperSettings,
    clock: Clock,
  ) {
    this.#docker = docker;
    this.#runId = runId;
    this.#settings = settings;
    this.#clock = clock;
  }

  /**
   * Holds the reaper of `runId`, and creates it when the run has none on this
   * engine. A reaper that closed is waited for until the engine removed it,
   * and one that ends while the hold starts is tried again: at most
   * `settings.retries` more times.
   */
  static async take(
    docker: Docker,
    runId: string,
    settings: ReaperSettings,
    clock: Clock,
  ): Promise<ReaperHold> {
    const hold = new ReaperHold(docker, runId, settings, clock);
    await hold.held();
    return hold;
  }

  /**
   * Resolves when this process holds the reaper: at once while the hold
   * lasts, and after the new hold when it ended. A hold that failed is tried
   * again by the next call.
   */
  async held(): Promise<void> {
    // The waits of a hold keep no process running, as its exec does not. A
    // caller that waits for the hold keeps this process running while it
    // waits, as the request that it waits to make would, for at most each
    // try of the hold: one exec and the closing time of a reaper.
    const ms =
      (this.#settings.retries + 1) *
      (this.#settings.requestTimeout + closingTime(this.#settings));
    using alive = timeout(ms, { clock: this.#clock });
    try {
      await untilAborted(this.#hold(), alive.signal);
    } catch (error) {
      if (!alive.signal.aborted) throw error;
      throw new Error(
        `The hold of the reaper ${reaperName(this.#runId)} did not end within ${ms} ms`,
        { cause: error },
      );
    }
  }

  /** The hold, once at a time: it is cleared when the hold ends, and a failed one is not kept. */
  readonly #hold = pMemoize(async (): Promise<void> => {
    const { retries } = this.#settings;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const reaper = await running(
        this.#docker,
        this.#runId,
        this.#settings,
        this.#clock,
      );
      if (reaper === undefined) continue;
      const answer = await this.#ask(reaper);
      if (answer === 'held') return;
      if (answer === 'closing')
        await closed(this.#docker, reaper, this.#settings, this.#clock);
    }
    throw new Error(
      `The reaper ${reaperName(this.#runId)} ended or closed on each of ${retries + 1} tries to hold it`,
    );
  });

  /** Asks `reaper` for a hold, and gives its answer. A hold that it gives is watched. */
  async #ask(reaper: Container): Promise<string | undefined> {
    let holder;
    try {
      holder = await reaper.spawn({ Cmd: HOLD }, { stdin: true, ref: false });
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
    const answer = await firstLine(output);
    if (answer === 'held') void this.#watch(output);
    return answer;
  }

  /**
   * Takes the hold again at once when its output ends while this process
   * lives. A failure of that hold is not kept: the next held() tries again.
   */
  async #watch(output: AsyncIterator<OutputChunk>): Promise<void> {
    await drained(output);
    pMemoizeClear(this.#hold);
    await this.#hold().catch(() => {});
  }
}

/**
 * Starts the reaper of the dead run `runId` with no wait for a first holder,
 * and does not wait for it (ADR 0020, item 9). A reaper of the run that still
 * runs keeps the run. One that ended is replaced, at most `settings.retries`
 * more times.
 */
export async function startReaper(
  docker: Docker,
  runId: string,
  settings: ReaperSettings = REAPER_DEFAULTS,
): Promise<void> {
  const immediate = { ...settings, firstHolder: 0 };
  for (let attempt = 0; attempt <= settings.retries; attempt++)
    if ((await running(docker, runId, immediate, globalThis)) !== undefined)
      return;
  throw new Error(
    `The reaper ${reaperName(runId)} ended on each of ${settings.retries + 1} tries to start it`,
  );
}

/**
 * The names that start with `test` in each running shared server: the
 * superset of a run's databases that the reaper's pass filters (ADR 0011,
 * item 4). A server that does not run, or does not answer its list within
 * `settings.requestTimeout`, counts as one with none (ADR 0011, item 6).
 */
export async function sharedDatabases(
  docker: Docker,
  settings: ReaperSettings,
  clock: Clock,
): Promise<string[]> {
  const names: string[] = [];
  for (const { Id, Labels } of await docker.containers.list({
    filters: { label: [SERVER_LABEL, KIND_LABEL] },
  })) {
    const collector = COLLECTORS.find(
      ({ kind }) => kind === Labels?.[KIND_LABEL],
    );
    const server = await docker.containers.find(Id);
    if (collector === undefined || server === undefined) continue;
    const { variable, fallback } = collector.credential;
    const credential =
      (await server.inspect()).Config?.Env?.find((entry) =>
        entry.startsWith(`${variable}=`),
      )?.slice(variable.length + 1) || fallback;
    if (credential === undefined) continue;
    using limit = timeout(settings.requestTimeout, { clock });
    let listed;
    try {
      listed = await server.exec(
        { Cmd: collector.command(credential, collector.list) },
        { signal: limit.signal },
      );
    } catch (error) {
      if (
        limit.signal.aborted ||
        error instanceof ContainerNotRunningError ||
        error instanceof ContainerNotFoundError
      )
        continue;
      throw error;
    }
    if (listed.exitCode !== 0) continue;
    names.push(
      ...listed.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }
  return names;
}

/**
 * Whether the engine holds nothing of the run `runId`: no reaper of it, and
 * nothing that one would remove, its containers but its shared servers, its
 * volumes, and its databases among `databases` (ADR 0020, item 9).
 */
export async function reaped(
  docker: Docker,
  runId: string,
  databases: () => Promise<readonly string[]>,
): Promise<boolean> {
  if ((await docker.containers.find(reaperName(runId))) !== undefined)
    return false;
  const filters = { label: [`${TEST_RUN_LABEL}=${runId}`] };
  const containers = await docker.containers.list({ all: true, filters });
  if (containers.some(({ Labels }) => Labels?.[SERVER_LABEL] === undefined))
    return false;
  if ((await docker.volumes.list({ filters })).length > 0) return false;
  const owned = new RegExp(ownedNames(runId.replaceAll('-', '')));
  return !(await databases()).some((name) => owned.test(name));
}
