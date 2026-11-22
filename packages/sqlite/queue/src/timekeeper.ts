import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';

import { type CronExpression, CronExpressionParser } from 'cron-parser';
import type {
  Clock,
  ClockTimer,
  Job,
  PgBossEventMap,
  SendOptions,
  WorkHandler,
  WorkOptions,
} from 'pg-boss';
import { policies, scheduleKinds, scheduleMissedPolicies } from 'pg-boss';

import { transaction } from '@zukhruf/sqlite-transaction';

import type { Activity } from './activity.ts';
import { ClaimTimer } from './claim-timer.ts';
import { CurrentOperation } from './in-flight.ts';
import { NaiveTimestamp } from './naive-timestamp.ts';
import { Recurrence } from './recurrence.ts';
import { Row } from './rows.ts';
import { SqlValues } from './sql-values.ts';

// One occurrence the pass files in the send-it queue: the request to send
// with the schedule's key and slot beside it, under the singleton key and
// slot that keep one job per (schedule, slot) (timekeeper.js:742, 776).
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

// One schedule sent every second, as the cron statement takes it (12.39.0:
// plans.js:3006-3083, timekeeper.js:893-918): the definition it was read
// under, with data and options as the row stores their text, the cursor value
// it moves to, and a job of its fields per occurrence.
export type ScheduledSend = {
  name: string;
  key: string;
  cron: string;
  timezone: string;
  data: string | null;
  options: string | null;
  through: Date;
  job: ScheduledJobFields;
  occurrences: Date[];
};

// A matched schedule's row of the statement's result: the cursor it read,
// and whether this statement moved it (plans.js:3078).
export type ScheduledReport = {
  name: string;
  key: string;
  prev: string | null;
  claimed: boolean;
};

type ScheduledJobFields = { data: unknown; options: SendOptions };

// What the timekeeper asks of the queue it keeps time for, as pg-boss's
// Timekeeper asks its Manager (timekeeper.js:291, 296, 307, 558, 718; 12.39.0:
// 810-811, 892).
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
  scheduledJobFields(
    name: string,
    data: unknown,
    options: SendOptions,
  ): ScheduledJobFields;
  getQueueCache(name: string): { policy: string };
  sendScheduled(sends: ScheduledSend[]): Promise<ScheduledReport[]>;
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
  // The stored text of data and options, which the cron statement matches
  // the row on (plans.js:3061-3062).
  storedData: string | null;
  storedOptions: string | null;
  createdOn: string;
};

// trySetCronTime's answer; claimedOn is the stamp a won claim wrote
// (12.39.0: plans.js:1510-1512, 1543).
type Claim = {
  priorCronOn: string | null;
  elapsed: number | null;
  claimed: boolean;
  claimedOn: string | null;
};

// A schedule sent every second, cached for the lease with its expression
// parsed and its job fields resolved once (timekeeper.js:793-830).
type SecondEntry = {
  schedule: Schedule;
  id: string;
  interval: CronExpression;
  job: ScheduledJobFields;
};

// What a schedule sent every second owes now (timekeeper.js:831-857).
type SecondSend = { entry: SecondEntry; occurrences: Date[]; through: number };

// The timekeeper between start() and stop(), with the database it reads and
// the timer of its passes.
type TimekeeperPhase =
  | { kind: 'stopped' }
  | { kind: 'keeping'; database: DatabaseSync; timer: ClaimTimer };

// pg-boss's Timekeeper (node_modules/pg-boss/dist/timekeeper.js) without the
// clock-skew loop (SQLite's clock is the database clock), kind relabels and
// last_job_id: only schedule() writes a row, so no row is mislabelled, and no
// method of the queue reads one back. A row an earlier release wrote can be
// unreadable (an empty cron, 12.37.0), and gets pg-boss's invalid_schedule
// warning. A pass every cronMonitorIntervalSeconds claims the instance-wide
// cron stamp, files each schedule's due occurrences in __pgboss__send-it, one
// job per minute slot, and the send-it worker forwards each to its queue. A
// schedule of precision 'second' is sent every second instead, straight to
// its queue, by the instance that holds the claim.
export class Timekeeper extends EventEmitter<
  Pick<PgBossEventMap, 'error' | 'warning'>
> {
  // timekeeper.js:13-15
  static readonly sendIt = '__pgboss__send-it';
  // timekeeper.js:50: how long an occurrence stays due, and the width of the
  // slot its job is filed in.
  static readonly #occurrenceWindowSeconds = 60;
  // timekeeper.js:343: the (queue, key, cron, zone) of each unreadable row
  // already warned about, replaced after each pass by the rows still broken.
  #warnedSchedules = new Set<string>();
  // timekeeper.js:52
  static readonly #missedPolicies: readonly unknown[] = Object.values(
    scheduleMissedPolicies,
  );

  readonly #clock: Clock;
  readonly #activity: Activity;
  readonly #config: TimekeeperConfig;
  readonly #manager: TimekeeperManager;
  #phase: TimekeeperPhase = { kind: 'stopped' };
  // pg-boss's _timekeeping: the pass in flight.
  readonly #pass = new CurrentOperation<void>();
  // timekeeper.js:44 (12.39.0): schedules per cron statement.
  static readonly #secondSendChunk = 500;
  // timekeeper.js:45 (12.39.0)
  static readonly #dayMs = 24 * 60 * 60 * 1000;
  // timekeeper.js:344-359 (12.39.0): a won cron claim is held as a lease of
  // one cronMonitorIntervalSeconds, during which this instance evaluates the
  // second-precision schedules its pass read every second, on a grid from
  // start(); no other instance reads them.
  #secondCronCache: SecondEntry[] = [];
  #leaseUntil = 0;
  #secondTickTimer: ClockTimer | undefined;
  #secondTickOrigin = 0;
  // pg-boss's _secondTicking: the tick in flight.
  readonly #secondTick = new CurrentOperation<void>();
  // Per [name, key], the cursor this instance's own last statement moved.
  readonly #secondCronHint = new Map<string, number>();
  // Schedules whose statement failed on its own, warned about once until
  // one succeeds.
  readonly #sendWarned = new Set<string>();

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

  // timekeeper.js:71-73: the name's underscores escaped, so the first
  // unescaped underscore pair is the separator.
  static #occurrenceKey(name: string, key: string): string {
    return `${name.replaceAll('_', '\\_')}__${key}`;
  }

  // timekeeper.js:81-84, at the minute width every caller passes (738, 1172)
  static #throttleSlot(instant: Date): string {
    const width = Timekeeper.#occurrenceWindowSeconds * 1000;
    return new Date(Math.floor(instant.getTime() / width) * width)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
  }

  // timekeeper.js:227-234: SQLite hands timestamps back as the text it
  // stored.
  static #toTime(value: string | null): number | null {
    if (value === null) {
      return null;
    }
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
  }

  // timekeeper.js:267-272
  static #missedPolicy(options: unknown): unknown {
    const missed =
      typeof options === 'object' && options !== null && 'missed' in options
        ? options.missed
        : undefined;
    return missed !== undefined && Timekeeper.#missedPolicies.includes(missed)
      ? missed
      : scheduleMissedPolicies.skip;
  }

  // timekeeper.js:391-416. The first pass runs on a real setImmediate, as
  // pg-boss's does, then every cronMonitorIntervalSeconds on the clock.
  async start(database: DatabaseSync): Promise<void> {
    if (this.#phase.kind === 'keeping') {
      return;
    }
    // timekeeper.js:399-402 (12.39.0): a restart surfaces a row nobody fixed
    // again.
    this.#warnedSchedules.clear();
    this.#sendWarned.clear();
    this.#secondCronHint.clear();
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
    // timekeeper.js:414-415 (12.39.0)
    this.#secondTickOrigin = this.#clock.now();
  }

  // timekeeper.js:417-497, which polls its pass flag every 10 ms of real
  // time.
  async stop(): Promise<void> {
    const phase = this.#phase;
    if (phase.kind !== 'keeping') {
      return;
    }
    this.#phase = { kind: 'stopped' };
    await this.#manager.offWork(Timekeeper.sendIt, { wait: true });
    phase.timer.stop();
    // timekeeper.js:431-437 (12.39.0)
    if (this.#secondTickTimer !== undefined) {
      this.#clock.clearTimeout(this.#secondTickTimer);
      this.#secondTickTimer = undefined;
    }
    await Promise.allSettled([
      this.#pass.inFlight?.wait(),
      this.#secondTick.inFlight?.wait(),
    ]);
  }

  // timekeeper.js:439-458 (12.39.0): chained, so a slow evaluation delays the
  // next instead of overlapping it, and left to lapse once the lease has run
  // out or nothing is cached, so an instance without the claim, or with no
  // second-precision schedule, does not wake every second. Arming while a
  // tick is pending does nothing.
  #scheduleSecondTick(): void {
    if (this.#phase.kind !== 'keeping' || this.#secondTickTimer !== undefined) {
      return;
    }
    const wait = 1000 - ((this.#clock.now() - this.#secondTickOrigin) % 1000);
    this.#secondTickTimer = this.#clock.setTimeout(() => {
      this.#secondTickTimer = undefined;
      // #onSecond reports its own failures, so this never rejects.
      void this.#onSecondTick();
    }, wait);
  }

  async #onSecondTick(): Promise<void> {
    try {
      await this.#onSecond();
    } finally {
      if (
        this.#clock.now() < this.#leaseUntil &&
        this.#secondCronCache.length > 0
      ) {
        this.#scheduleSecondTick();
      }
    }
  }

  // timekeeper.js:459-497 (12.39.0): every occurrence of the cached schedules
  // since this instance last evaluated them, while the lease lasts.
  async #onSecond(): Promise<void> {
    const phase = this.#phase;
    if (phase.kind !== 'keeping' || this.#secondTick.inFlight) {
      return;
    }
    await this.#secondTick.run(this.#secondPass());
  }

  async #secondPass(): Promise<void> {
    try {
      if (
        this.#clock.now() >= this.#leaseUntil ||
        this.#secondCronCache.length === 0
      ) {
        return;
      }
      const databaseTime = this.#clock.now();
      const sends: SecondSend[] = [];
      for (const entry of this.#secondCronCache) {
        let send: SecondSend | null;
        try {
          send = this.#secondSend(entry, databaseTime, null);
        } catch {
          // The pass that cached the row read it the same way and warned.
          continue;
        }
        if (send !== null) {
          sends.push(send);
        }
      }
      if (sends.length > 0 && this.#phase.kind === 'keeping') {
        await this.#sendSeconds(sends);
      }
    } catch (error) {
      this.emit(
        'error',
        Error.isError(error) ? error : new Error(String(error)),
      );
    }
  }

  // timekeeper.js:552-619
  async #onCron(): Promise<void> {
    if (this.#phase.kind !== 'keeping' || this.#pass.inFlight) {
      return;
    }
    await this.#pass.run(this.#cronPass(this.#phase));
  }

  async #cronPass(phase: {
    database: DatabaseSync;
    timer: ClaimTimer;
  }): Promise<void> {
    try {
      const { priorCronOn, elapsed, claimed, claimedOn } =
        await this.#activity.query(() =>
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
        // timekeeper.js:592-609 (12.39.0): the rows are read once for the
        // lease, which ends an interval after the stamp the claim wrote; the
        // tick is armed whatever the pass did after its sends.
        const schedules = await this.#activity.query(() =>
          Timekeeper.#getSchedules(phase.database),
        );
        this.#leaseUntil =
          (Timekeeper.#toTime(claimedOn) ?? this.#clock.now()) +
          this.#config.cronMonitorIntervalSeconds * 1000;
        try {
          await this.#cron(priorCronOn, schedules);
        } finally {
          if (this.#secondCronCache.length > 0) {
            this.#scheduleSecondTick();
          }
        }
      }
    } catch (error) {
      this.emit(
        'error',
        Error.isError(error) ? error : new Error(String(error)),
      );
    }
  }

  // timekeeper.js:641-646: until the claim it lost to comes due, plus a
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

  // trySetCronTime and trySetTimestamp (plans.js:1503-1513, 1538-1545): the
  // stamp it replaced and its age, whether this pass moved it, and the stamp
  // it wrote (12.39.0: plans.js:1510-1512, 1543). A stamp never written
  // counts as a week old.
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
        const claimedOn = claimed ? SqlValues.asIso(now) : null;
        if (claimedOn !== null) {
          db.prepare('UPDATE pgboss_version SET cron_on = ?').run(claimedOn);
        }
        return { priorCronOn, elapsed, claimed, claimedOn };
      },
      { mode: 'immediate' },
    );
  }

  // timekeeper.js:655-792 (12.39.0), one instant for the whole pass, over
  // the rows onCron read for the lease.
  async #cron(
    priorCronOn: string | null,
    schedules: Schedule[],
  ): Promise<void> {
    const scheduled: SlottedJob[] = [];
    const databaseTime = this.#clock.now();
    const windowStart =
      databaseTime - Timekeeper.#occurrenceWindowSeconds * 1000;
    const lastPass = Timekeeper.#toTime(priorCronOn);
    // timekeeper.js:671-676: a gap no pass covered, where `missed` decides
    // what a schedule sent every second owes.
    const gapSince =
      lastPass !== null && lastPass < windowStart ? lastPass : null;
    const entries = this.#cacheSecondSchedules(schedules);
    const seconds: SecondSend[] = [];
    const stillBroken = new Set<string>();
    for (const schedule of schedules) {
      const { name, key, data, options, kind, cron, timezone } = schedule;
      // timekeeper.js:679-688: one row never decides the others', and a row
      // the pass cannot read warns once, not every pass, since it never
      // heals on its own.
      const warn = (error: unknown) => {
        const warned = JSON.stringify([name, key, cron, timezone]);
        stillBroken.add(warned);
        if (!this.#warnedSchedules.has(warned)) {
          const reason = Error.isError(error) ? error.message : String(error);
          this.emit('warning', {
            message: `Warning: schedule for queue "${name}" (key "${key}") could not be evaluated and was skipped: ${reason}`,
            data: { queue: name, key, cron, timezone },
          });
        }
      };
      // timekeeper.js:689-705: sent by the cron statement, not through
      // send-it; a row whose job fields could not be resolved was warned
      // about when it was cached.
      if (
        kind === scheduleKinds.cron &&
        Recurrence.isSecondCron(cron, options)
      ) {
        const entry = entries.get(JSON.stringify([name, key]));
        if (entry !== undefined) {
          try {
            const send = this.#secondSend(entry, databaseTime, gapSince);
            if (send !== null) {
              seconds.push(send);
            }
          } catch (error) {
            warn(error);
          }
        }
        continue;
      }
      let due: Date[];
      try {
        due = Timekeeper.#readOccurrences(cron, kind, timezone, databaseTime);
      } catch (error) {
        warn(error);
        continue;
      }
      // timekeeper.js:724-734 catches a catch-up that cannot be read. Its
      // read is of the rule that the read above just read, and only
      // schedule() writes a rule, which it refuses when a pass cannot read
      // it (ADR 0003), so no failure is expected here.
      const missed = Timekeeper.#missedOccurrence(
        schedule,
        lastPass,
        windowStart,
      );
      // timekeeper.js:765-777: a set of slots, so a missed occurrence and a
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
          // (plans.js:2879).
          singletonOn: NaiveTimestamp.fromUtc(new Date(`${slot}Z`)),
        });
      }
    }
    this.#warnedSchedules = stillBroken;
    if (scheduled.length > 0 && this.#phase.kind === 'keeping') {
      await this.#manager.insert(Timekeeper.sendIt, scheduled);
    }
    // timekeeper.js:783-785 (12.39.0)
    if (seconds.length > 0 && this.#phase.kind === 'keeping') {
      await this.#sendSeconds(seconds);
    }
  }

  // timekeeper.js:793-830 (12.39.0): caches the schedules sent every second
  // for the lease. A row whose job fields cannot be resolved is warned about
  // and left out. `replace` false answers with the entries and leaves the
  // cache to the caller. getQueueCache reads the live row here, so it is
  // synchronous.
  #cacheSecondSchedules(
    schedules: Schedule[],
    replace = true,
  ): Map<string, SecondEntry> {
    const entries = new Map<string, SecondEntry>();
    for (const schedule of schedules) {
      const { name, key, data, options, kind, cron, timezone } = schedule;
      if (
        kind !== scheduleKinds.cron ||
        !Recurrence.isSecondCron(cron, options)
      ) {
        continue;
      }
      const id = JSON.stringify([name, key]);
      try {
        const {
          db: _db,
          missed: _missed,
          precision: _precision,
          ...sendOptions
        } = Timekeeper.#optionsObject(options);
        const interval = CronExpressionParser.parse(cron, {
          tz: timezone || 'UTC',
          strict: false,
        });
        const job = this.#manager.scheduledJobFields(name, data, sendOptions);
        const { policy } = this.#manager.getQueueCache(name);
        // send() refuses the job up front, where the cron statement would
        // fail on the CHECK.
        assert(
          policy !== policies.key_strict_fifo || job.options.singletonKey,
          `${policies.key_strict_fifo} queues require a singletonKey`,
        );
        entries.set(id, { schedule, id, interval, job });
      } catch (error) {
        const reason = Error.isError(error) ? error.message : String(error);
        this.#warnSend(
          schedule,
          `Warning: schedule for queue "${name}" (key "${key}") could not be evaluated and was skipped: ${reason}`,
        );
      }
    }
    if (replace) {
      this.#secondCronCache = [...entries.values()];
    }
    return entries;
  }

  // A stored options blob as the object pg-boss destructures (`options ??
  // {}`); a non-object reads as no options.
  static #optionsObject(options: unknown): Record<string, unknown> {
    return typeof options === 'object' && options !== null
      ? { ...options }
      : {};
  }

  // timekeeper.js:831-857 (12.39.0): without a gap, every occurrence in the
  // due window after this instance's hint, the statement trimming what the
  // live cursor has passed. After a gap, `skip` sends nothing and moves the
  // cursor to now; `once` sends the latest occurrence since the gap began.
  #secondSend(
    entry: SecondEntry,
    databaseTime: number,
    gapSince: number | null,
  ): SecondSend | null {
    const { schedule, interval } = entry;
    const tz = schedule.timezone || 'UTC';
    const windowStart =
      databaseTime - Timekeeper.#occurrenceWindowSeconds * 1000;
    if (gapSince !== null) {
      if (
        Timekeeper.#missedPolicy(schedule.options) ===
        scheduleMissedPolicies.skip
      ) {
        return { entry, occurrences: [], through: databaseTime };
      }
      const from = Math.max(
        gapSince,
        Timekeeper.#toTime(schedule.createdOn) ?? gapSince,
      );
      const latest = Timekeeper.#latestOccurrenceBefore(
        schedule.cron,
        scheduleKinds.cron,
        tz,
        new Date(from),
        new Date(databaseTime),
      );
      return latest === null
        ? null
        : { entry, occurrences: [latest], through: latest.getTime() };
    }
    const after = Math.max(
      this.#secondCronHint.get(entry.id) ?? windowStart,
      windowStart,
    );
    const occurrences = Recurrence.cronOccurrencesBetween(
      interval,
      tz,
      after,
      databaseTime,
    );
    const last = occurrences.at(-1);
    return last === undefined
      ? null
      : { entry, occurrences, through: last.getTime() };
  }

  // timekeeper.js:858-885 (12.39.0): in chunks; a chunk that fails is sent
  // again a schedule at a time, so one bad row costs only its own jobs and
  // is warned about. A failed send moves nothing, and the next tick sends
  // the same occurrences while they are due. CockroachDB's lost race
  // (timekeeper.js:212-217) has no SQLite form.
  async #sendSeconds(sends: SecondSend[]): Promise<void> {
    for (let i = 0; i < sends.length; i += Timekeeper.#secondSendChunk) {
      const chunk = sends.slice(i, i + Timekeeper.#secondSendChunk);
      try {
        await this.#sendSecondChunk(chunk);
      } catch {
        for (const send of chunk) {
          try {
            await this.#sendSecondChunk([send]);
          } catch (error) {
            const { name, key } = send.entry.schedule;
            const reason = Error.isError(error) ? error.message : String(error);
            this.#warnSend(
              send.entry.schedule,
              `Warning: schedule for queue "${name}" (key "${key}") could not be sent: ${reason}`,
            );
          }
        }
      }
    }
  }

  // timekeeper.js:886-976 (12.39.0), without last_job_id, which this queue
  // does not keep (see the class comment).
  async #sendSecondChunk(unsorted: SecondSend[]): Promise<void> {
    const sends = unsorted.toSorted((a, b) =>
      a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0,
    );
    const rows = await this.#manager.sendScheduled(
      sends.map(({ entry, occurrences, through }) => {
        const { name, key, cron, timezone, storedData, storedOptions } =
          entry.schedule;
        return {
          name,
          key,
          cron,
          timezone: timezone || 'UTC',
          data: storedData,
          options: storedOptions,
          through: new Date(through),
          job: entry.job,
          occurrences,
        };
      }),
    );
    const byId = new Map(sends.map((send) => [send.entry.id, send]));
    const matched = new Set<string>();
    for (const row of rows) {
      const id = JSON.stringify([row.name, row.key]);
      const send = byId.get(id);
      if (send === undefined) {
        continue;
      }
      matched.add(id);
      this.#sendWarned.delete(id);
      // timekeeper.js:941-947: claimed, or already past by a cursor someone
      // else moved: every occurrence up to `through` has been sent.
      const prev = Timekeeper.#toTime(row.prev);
      if (row.claimed || (prev !== null && prev >= send.through)) {
        this.#secondCronHint.set(
          id,
          Math.max(this.#secondCronHint.get(id) ?? send.through, send.through),
        );
      }
    }
    // timekeeper.js:949-963: a schedule removed or changed since the lease
    // read it matches nothing, and its row is read again.
    const phase = this.#phase;
    const unmatched = sends
      .filter(({ entry }) => !matched.has(entry.id))
      .map(({ entry }) => entry);
    if (unmatched.length > 0 && phase.kind === 'keeping') {
      const reread: Schedule[] = [];
      for (const { schedule } of unmatched) {
        reread.push(
          ...(await this.#activity.query(() =>
            Timekeeper.#getSchedules(phase.database, schedule),
          )),
        );
      }
      const refreshed = this.#cacheSecondSchedules(reread, false);
      const gone = new Set(unmatched.map((entry) => entry.id));
      this.#secondCronCache = [
        ...this.#secondCronCache.filter((entry) => !gone.has(entry.id)),
        ...refreshed.values(),
      ];
    }
  }

  // timekeeper.js:977-986 (12.39.0): warned once per schedule until one of
  // its sends succeeds, since a row that cannot be sent fails the same way
  // every second.
  #warnSend(schedule: Schedule, message: string): void {
    const { name, key, cron, timezone } = schedule;
    const id = JSON.stringify([name, key]);
    if (this.#sendWarned.has(id)) {
      return;
    }
    this.#sendWarned.add(id);
    this.emit('warning', {
      message,
      data: { queue: name, key, cron, timezone },
    });
  }

  // getSchedules (plans.js:1713-1735), in name and key order, or the one row
  // of a name and key (timekeeper.js:1201-1216).
  static #getSchedules(
    db: DatabaseSync,
    only?: { name: string; key: string },
  ): Schedule[] {
    const columns = `SELECT queue_name, key, kind, cron, COALESCE(timezone, 'UTC') AS timezone,
          data, options, created_on
        FROM pgboss_schedule`;
    return (
      only === undefined
        ? db.prepare(`${columns} ORDER BY queue_name, key`).all()
        : db
            .prepare(`${columns} WHERE queue_name = ? AND key = ?`)
            .all(only.name, only.key)
    ).map((value) => {
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
        storedData: data,
        storedOptions: options,
        createdOn: Row.readString(row, 'created_on'),
      };
    });
  }

  // timekeeper.js:1048-1058: under `once`, the latest occurrence in
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

  // timekeeper.js:1067-1092 (12.39.0). cron-parser's prev() answers strictly
  // before its reference, so the reference is a millisecond past `until`.
  // prev() throws for up to a day after a time the clocks skipped, as
  // `30 30 0 * * *` has in America/Havana, so that day is read forwards, and
  // each day before it the same way, as far back as `after`.
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
    for (
      let reference = until.getTime();
      reference > after.getTime();
      reference -= Timekeeper.#dayMs
    ) {
      const interval = CronExpressionParser.parse(expression, {
        tz,
        strict: false,
        currentDate: new Date(reference + 1),
      });
      try {
        const occurrence = Recurrence.previousOccurrence(interval, tz);
        return occurrence.getTime() > after.getTime() ? occurrence : null;
      } catch {
        const latest = Recurrence.latestOccurrenceForward(
          expression,
          tz,
          Math.max(after.getTime(), reference - Timekeeper.#dayMs),
          reference,
        );
        if (latest !== null) {
          return latest;
        }
      }
    }
    return null;
  }

  // timekeeper.js:1110-1124: every occurrence in the last minute, a cron
  // expression's latest only.
  static #readOccurrences(
    expression: string,
    kind: string,
    tz: string,
    databaseTime: number,
  ): Date[] {
    // dueOccurrences (timekeeper.js:1003): an empty expression, which a row an
    // earlier release stored can hold, is refused first.
    Recurrence.assertExpression(expression);
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
    const previous = Recurrence.previousOccurrence(
      CronExpressionParser.parse(expression, {
        tz,
        strict: false,
        currentDate: new Date(databaseTime + 1),
      }),
      tz,
    );
    return previous.getTime() > window.getTime() ? [previous] : [];
  }

  // timekeeper.js:1129-1136: an error event nobody listens for must not fail
  // the send-it job, which would replay every occurrence in its batch.
  #reportSendItError(error: unknown): void {
    const reported = Error.isError(error) ? error : new Error(String(error));
    try {
      this.emit('error', reported);
    } catch (thrown) {
      // An Error nobody listens for, here or on the queue that re-emits it,
      // comes back out of emit() itself, and a listener that throws has no
      // caller either: nothing is left to tell, so it is a process warning.
      process.emitWarning(
        Error.isError(thrown)
          ? thrown
          : new Error(String(thrown), { cause: thrown }),
      );
    }
  }

  // timekeeper.js:1137-1148 (12.39.0): each occurrence's request goes to
  // send() without its key and slot, and its options without db, missed and
  // precision, which are never send options; a send that rejects is
  // reported, and the send-it job completes either way.
  async #onSendIt(jobs: Job<unknown>[]): Promise<void> {
    const results = await Promise.allSettled(
      jobs.map(async ({ data }) => {
        if (typeof data !== 'object' || data === null) {
          throw new TypeError('send-it job data must be an object');
        }
        const {
          key: _key,
          slot: _slot,
          ...request
        }: Record<string, unknown> = { ...data };
        const {
          db: _db,
          missed: _missed,
          precision: _precision,
          ...options
        } = Timekeeper.#optionsObject(request.options);
        return await this.#manager.send({ ...request, options });
      }),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        this.#reportSendItError(result.reason);
      }
    }
  }
}
