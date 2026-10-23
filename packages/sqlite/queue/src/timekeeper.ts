import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';

import { CronExpressionParser } from 'cron-parser';
import type {
  Clock,
  Job,
  PgBossEventMap,
  WorkHandler,
  WorkOptions,
} from 'pg-boss';
import { scheduleKinds, scheduleMissedPolicies } from 'pg-boss';

import { transaction } from '@zukhruf/sqlite-transaction';

import type { Activity } from './activity.ts';
import { ClaimTimer } from './claim-timer.ts';
import { InFlight } from './in-flight.ts';
import { NaiveTimestamp } from './naive-timestamp.ts';
import { Recurrence } from './recurrence.ts';
import { Row } from './rows.ts';
import { SqlValues } from './sql-values.ts';

// One occurrence the pass files in the send-it queue: the request to send
// with the schedule's key and slot beside it, under the singleton key and
// slot that keep one job per (schedule, slot) (timekeeper.js:480, 514).
export type SlottedJob = {
  data: {
    name: string;
    key: string;
    data: unknown;
    options: unknown;
    slot: string;
  };
  singletonKey: string;
  singletonOn: string;
};

// What the timekeeper asks of the queue it keeps time for, as pg-boss's
// Timekeeper asks its Manager (timekeeper.js:252, 257, 268, 519, 673).
export type TimekeeperManager = {
  createQueue(name: string): Promise<void>;
  work(
    name: string,
    options: WorkOptions,
    handler: WorkHandler<unknown>,
  ): Promise<string>;
  offWork(name: string, options: { wait: boolean }): Promise<void>;
  send(request: unknown): Promise<string | null>;
  insert(name: string, jobs: SlottedJob[]): Promise<void>;
};

export type TimekeeperConfig = {
  cronMonitorIntervalSeconds: number;
  cronWorkerIntervalSeconds: number;
};

type Schedule = {
  name: string;
  key: string;
  kind: string;
  cron: string;
  timezone: string;
  data: unknown;
  options: unknown;
  createdOn: string;
};

type Claim = {
  priorCronOn: string | null;
  elapsed: number | null;
  claimed: boolean;
};

// The timekeeper between start() and stop(), with the database it reads and
// the timer of its passes.
type TimekeeperPhase =
  | { kind: 'stopped' }
  | { kind: 'keeping'; database: DatabaseSync; timer: ClaimTimer };

// pg-boss's Timekeeper (node_modules/pg-boss/dist/timekeeper.js) without the
// clock-skew loop (SQLite's clock is the database clock), invalid_schedule
// warnings, kind relabels and last_job_id: only schedule() writes a row, so
// no row is unreadable or mislabelled, and no method of the queue reads one
// back. A pass every cronMonitorIntervalSeconds claims the instance-wide
// cron stamp, files each schedule's due occurrences in __pgboss__send-it, one
// job per minute slot, and the send-it worker forwards each to its queue.
export class Timekeeper extends EventEmitter<Pick<PgBossEventMap, 'error'>> {
  // timekeeper.js:12-14
  static readonly sendIt = '__pgboss__send-it';
  // timekeeper.js:46: how long an occurrence stays due, and the width of the
  // slot its job is filed in.
  static readonly #occurrenceWindowSeconds = 60;
  // timekeeper.js:48
  static readonly #missedPolicies: readonly unknown[] = Object.values(
    scheduleMissedPolicies,
  );

  readonly #clock: Clock;
  readonly #activity: Activity;
  readonly #config: TimekeeperConfig;
  readonly #manager: TimekeeperManager;
  #phase: TimekeeperPhase = { kind: 'stopped' };
  // pg-boss's _timekeeping: the pass in flight.
  #pass: InFlight<void> | null = null;

  constructor(
    clock: Clock,
    activity: Activity,
    config: TimekeeperConfig,
    manager: TimekeeperManager,
  ) {
    super();
    this.#clock = clock;
    this.#activity = activity;
    this.#config = config;
    this.#manager = manager;
  }

  // timekeeper.js:66-68: the name's underscores escaped, so the first
  // unescaped underscore pair is the separator.
  static #occurrenceKey(name: string, key: string): string {
    return `${name.replaceAll('_', '\\_')}__${key}`;
  }

  // timekeeper.js:76-79
  static #throttleSlot(instant: Date): string {
    const width = Timekeeper.#occurrenceWindowSeconds * 1000;
    return new Date(Math.floor(instant.getTime() / width) * width)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
  }

  // timekeeper.js:105-112: SQLite hands timestamps back as the text it
  // stored.
  static #toTime(value: string | null): number | null {
    if (value === null) {
      return null;
    }
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
  }

  // timekeeper.js:145-150
  static #missedPolicy(options: unknown): unknown {
    const missed =
      typeof options === 'object' && options !== null && 'missed' in options
        ? options.missed
        : undefined;
    return missed !== undefined && Timekeeper.#missedPolicies.includes(missed)
      ? missed
      : scheduleMissedPolicies.skip;
  }

  // timekeeper.js:241-262. The first pass runs on a real setImmediate, as
  // pg-boss's does, then every cronMonitorIntervalSeconds on the clock.
  async start(database: DatabaseSync): Promise<void> {
    if (this.#phase.kind === 'keeping') {
      return;
    }
    await this.#manager.createQueue(Timekeeper.sendIt);
    await this.#manager.work(
      Timekeeper.sendIt,
      {
        pollingIntervalSeconds: this.#config.cronWorkerIntervalSeconds,
        batchSize: 50,
      },
      (jobs) => this.#onSendIt(jobs),
    );
    void setImmediate().then(() => this.#onCron());
    this.#phase = {
      kind: 'keeping',
      database,
      timer: new ClaimTimer(
        this.#clock,
        this.#config.cronMonitorIntervalSeconds,
        () => this.#onCron(),
      ),
    };
  }

  // timekeeper.js:263-280, which polls its pass flag every 10 ms of real
  // time.
  async stop(): Promise<void> {
    const phase = this.#phase;
    if (phase.kind !== 'keeping') {
      return;
    }
    this.#phase = { kind: 'stopped' };
    await this.#manager.offWork(Timekeeper.sendIt, { wait: true });
    phase.timer.stop();
    await this.#pass?.settled();
  }

  // timekeeper.js:335-384
  async #onCron(): Promise<void> {
    if (this.#phase.kind !== 'keeping' || this.#pass) {
      return;
    }
    const pass = this.#cronPass(this.#phase);
    this.#pass = new InFlight(pass);
    try {
      await pass;
    } finally {
      this.#pass = null;
    }
  }

  async #cronPass(phase: {
    database: DatabaseSync;
    timer: ClaimTimer;
  }): Promise<void> {
    try {
      const { priorCronOn, elapsed, claimed } = await this.#activity.query(() =>
        Timekeeper.#trySetCronTime(
          phase.database,
          this.#config.cronMonitorIntervalSeconds,
          new Date(this.#clock.now()),
        ),
      );
      if (claimed) {
        phase.timer.anchor();
      } else {
        phase.timer.anchor(this.#claimRetryDelay(elapsed));
      }
      if (this.#phase.kind === 'keeping' && claimed) {
        await this.#cron(phase.database, priorCronOn);
      }
    } catch (error) {
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  // timekeeper.js:406-411: until the claim it lost to comes due, plus a
  // quarter of the interval capped at a second.
  #claimRetryDelay(elapsed: number | null): number {
    const interval = this.#config.cronMonitorIntervalSeconds * 1000;
    const age = Number(elapsed);
    const remaining =
      Number.isFinite(age) && age > 0
        ? Math.max(0, interval - age * 1000)
        : interval;
    return remaining + Math.min(1000, interval / 4);
  }

  // trySetCronTime and trySetTimestamp (plans.js:1078-1086, 1111-1118): the
  // stamp it replaced and its age, and whether this pass moved it. A stamp
  // never written counts as a week old.
  static #trySetCronTime(db: DatabaseSync, seconds: number, now: Date): Claim {
    return transaction(
      db,
      () => {
        const row = Row.parse(
          db.prepare('SELECT cron_on FROM pgboss_version').get(),
          'version',
        );
        const priorCronOn = Row.readNullableString(row, 'cron_on');
        const prior = Timekeeper.#toTime(priorCronOn);
        const elapsed = prior === null ? null : (now.getTime() - prior) / 1000;
        const claimed =
          (now.getTime() - (prior ?? now.getTime() - 604_800_000)) / 1000 >=
          seconds;
        if (claimed) {
          db.prepare('UPDATE pgboss_version SET cron_on = ?').run(
            SqlValues.asIso(now),
          );
        }
        return { priorCronOn, elapsed, claimed };
      },
      { mode: 'immediate' },
    );
  }

  // timekeeper.js:418-527, one instant for the whole pass.
  async #cron(db: DatabaseSync, priorCronOn: string | null): Promise<void> {
    const schedules = await this.#activity.query(() =>
      Timekeeper.#getSchedules(db),
    );
    const scheduled: SlottedJob[] = [];
    const databaseTime = this.#clock.now();
    const windowStart =
      databaseTime - Timekeeper.#occurrenceWindowSeconds * 1000;
    const lastPass = Timekeeper.#toTime(priorCronOn);
    for (const schedule of schedules) {
      const { name, key, data, options, kind, cron, timezone } = schedule;
      let due: Date[];
      try {
        due = Timekeeper.#readOccurrences(cron, kind, timezone, databaseTime);
      } catch {
        // timekeeper.js:450-458: one row never decides the others'.
        continue;
      }
      let missed: Date | null = null;
      try {
        missed = Timekeeper.#missedOccurrence(schedule, lastPass, windowStart);
      } catch {
        // timekeeper.js:464-474: the gap closes anyway, since the claim has
        // moved.
      }
      // timekeeper.js:503-515: a set of slots, so a missed occurrence and a
      // due one in the same minute send one job.
      const slots = new Set<string>();
      if (missed !== null) {
        slots.add(Timekeeper.#throttleSlot(missed));
      }
      for (const occurrence of due) {
        slots.add(Timekeeper.#throttleSlot(occurrence));
      }
      for (const slot of slots) {
        scheduled.push({
          data: { name, key, data, options, slot },
          singletonKey: Timekeeper.#occurrenceKey(name, key),
          // The insert casts the slot to a zoneless timestamp
          // (plans.js:2258).
          singletonOn: NaiveTimestamp.fromUtc(new Date(`${slot}Z`)),
        });
      }
    }
    if (scheduled.length > 0 && this.#phase.kind === 'keeping') {
      await this.#manager.insert(Timekeeper.sendIt, scheduled);
    }
  }

  // getSchedules (plans.js:1276-1290), in name and key order.
  static #getSchedules(db: DatabaseSync): Schedule[] {
    return db
      .prepare(
        `SELECT queue_name, key, kind, cron, COALESCE(timezone, 'UTC') AS timezone,
          data, options, created_on
        FROM pgboss_schedule
        ORDER BY queue_name, key`,
      )
      .all()
      .map((value) => {
        const row = Row.parse(value, 'schedule');
        const data = Row.readNullableString(row, 'data');
        const options = Row.readNullableString(row, 'options');
        return {
          name: Row.readString(row, 'queue_name'),
          key: Row.readString(row, 'key'),
          kind: Row.readString(row, 'kind'),
          cron: Row.readString(row, 'cron'),
          timezone: Row.readString(row, 'timezone'),
          data: data === null ? null : JSON.parse(data),
          options: options === null ? null : JSON.parse(options),
          createdOn: Row.readString(row, 'created_on'),
        };
      });
  }

  // timekeeper.js:591-601: under `once`, the latest occurrence in
  // (max(lastPass, createdOn), windowStart], the gap no pass covered.
  static #missedOccurrence(
    schedule: Schedule,
    lastPass: number | null,
    windowStart: number,
  ): Date | null {
    const { cron, kind, timezone, options, createdOn } = schedule;
    if (
      Timekeeper.#missedPolicy(options) === scheduleMissedPolicies.skip ||
      lastPass === null
    ) {
      return null;
    }
    const from = Math.max(lastPass, Timekeeper.#toTime(createdOn) ?? lastPass);
    if (from >= windowStart) {
      return null;
    }
    return Timekeeper.#latestOccurrenceBefore(
      cron,
      kind,
      timezone,
      new Date(from),
      new Date(windowStart),
    );
  }

  // timekeeper.js:610-621. cron-parser's prev() answers strictly before its
  // reference, so the reference is a millisecond past `until`.
  static #latestOccurrenceBefore(
    expression: string,
    kind: string,
    tz: string,
    after: Date,
    until: Date,
  ): Date | null {
    if (kind === scheduleKinds.rrule) {
      return Recurrence.latestOccurrenceBefore(expression, after, until, tz);
    }
    const occurrence = CronExpressionParser.parse(expression, {
      tz,
      strict: false,
      currentDate: new Date(until.getTime() + 1),
    })
      .prev()
      .toDate();
    return occurrence.getTime() > after.getTime() ? occurrence : null;
  }

  // timekeeper.js:639-653: every occurrence in the last minute, a cron
  // expression's latest only.
  static #readOccurrences(
    expression: string,
    kind: string,
    tz: string,
    databaseTime: number,
  ): Date[] {
    const window = new Date(
      databaseTime - Timekeeper.#occurrenceWindowSeconds * 1000,
    );
    if (kind === scheduleKinds.rrule) {
      return Recurrence.occurrencesInWindow(
        expression,
        window,
        new Date(databaseTime),
        tz,
      );
    }
    const previous = CronExpressionParser.parse(expression, {
      tz,
      strict: false,
      currentDate: new Date(databaseTime + 1),
    })
      .prev()
      .toDate();
    return previous.getTime() > window.getTime() ? [previous] : [];
  }

  // timekeeper.js:658-665: an error event nobody listens for must not fail
  // the send-it job, which would replay every occurrence in its batch.
  #reportSendItError(error: unknown): void {
    try {
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error)),
      );
    } catch {
      // nothing left to report it to
    }
  }

  // timekeeper.js:666-687: each occurrence's request goes to send() without
  // its key and slot; a send that rejects is reported, and the send-it job
  // completes either way.
  async #onSendIt(jobs: Job<unknown>[]): Promise<void> {
    const results = await Promise.allSettled(
      jobs.map(async ({ data }) => {
        if (typeof data !== 'object' || data === null) {
          throw new TypeError('send-it job data must be an object');
        }
        const request = Object.fromEntries(
          Object.entries(data).filter(
            ([field]) => field !== 'key' && field !== 'slot',
          ),
        );
        return await this.#manager.send(request);
      }),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        this.#reportSendItError(result.reason);
      }
    }
  }
}
