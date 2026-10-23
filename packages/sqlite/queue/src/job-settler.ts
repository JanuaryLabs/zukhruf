import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { type JobAttempt, policies } from 'pg-boss';

import { transaction } from '@zukhruf/sqlite-transaction';

import { CompletionData } from './completion-data.ts';
import { DatabaseError } from './database-error.ts';
import { Database } from './database.ts';
import { JobRows } from './job-rows.ts';
import type { JobRow } from './job-rows.ts';
import { QueueRows } from './queue-rows.ts';
import { Row } from './rows.ts';
import { SqlValues } from './sql-values.ts';
import { Uuid } from './uuid.ts';

// pg-boss's attemptFence (node_modules/pg-boss/dist/plans.js:2051-2054): a
// settle given the attempt it was claimed at touches the job only while that
// attempt still holds it.
const ATTEMPT_FENCE = "AND state = 'active' AND retry_count = ?";

// A job's settle at the attempt its worker claimed, with the output stored on
// it (node_modules/pg-boss/dist/manager.js:393).
export type JobOutcome = JobAttempt & { output: unknown };

type Settle = {
  id: string;
  attempt: number | undefined;
  output: string | null;
};

export class JobSettler {
  // pg-boss's mapCommandResponse over settledCountAndIds (node_modules/pg-boss/
  // dist/manager.js:1623-1632, plans.js:2413-2415): the ids a settle touched,
  // each once, and their count.
  static response(ids: string[], settled: string[]) {
    return {
      jobs: ids,
      requested: ids.length,
      affected: settled.length,
      settled,
    };
  }

  static complete(
    db: DatabaseSync,
    name: string,
    ids: string[],
    attempts: number[],
    data: unknown,
    now: Date,
  ): void {
    const output = CompletionData.serialize(data);
    JobSettler.#completeEach(
      db,
      name,
      ids.map((id, index) => ({ id, attempt: attempts[index], output })),
      now,
    );
  }

  // completeJobsWithOutputs (node_modules/pg-boss/dist/plans.js:2134-2151):
  // each job its own output.
  static completeWithOutputs(
    db: DatabaseSync,
    name: string,
    outcomes: JobOutcome[],
    now: Date,
  ): void {
    JobSettler.#completeEach(
      db,
      name,
      JobSettler.#serializeOutputs(outcomes),
      now,
    );
  }

  static #completeEach(
    db: DatabaseSync,
    name: string,
    settles: Settle[],
    now: Date,
  ): void {
    const isoNow = SqlValues.asIso(now);
    const statement = db.prepare(
      `UPDATE pgboss_job
      SET state = 'completed', completed_on = ?, output = ?
      WHERE queue_name = ? AND id = ? ${ATTEMPT_FENCE}`,
    );

    transaction(
      db,
      () => {
        for (const { id, attempt, output } of settles) {
          statement.run(isoNow, output, name, id, attempt ?? null);
        }
      },
      { mode: 'immediate' },
    );
  }

  // fail() past its argument checks, for any value: a handler's throw or
  // shutdown's message reach it as they are (manager.js:639-655, 893).
  static fail(
    db: DatabaseSync,
    name: string,
    ids: string[],
    data: unknown,
    attempts: number[] | undefined,
    now: Date,
  ): string[] {
    // Postgres reads the bound ids before the output (manager.js:1691).
    const uuids = ids.map((jobId) => Uuid.canonical(jobId));
    const output = CompletionData.serialize(data);
    return JobSettler.#failEach(
      db,
      name,
      uuids.map((id, index) => ({ id, attempt: attempts?.[index], output })),
      false,
      now,
    );
  }

  // failJobs as the supervisor runs it (node_modules/pg-boss/dist/plans.js:
  // 2372-2386, 2403-2408): every job `where` selects, unfenced, with one
  // output, in the select's transaction.
  static failJobs(
    db: DatabaseSync,
    [where, ...values]: [sql: string, ...values: SQLInputValue[]],
    output: string,
    now: Date,
  ): void {
    transaction(
      db,
      () => {
        const selected = db
          .prepare(
            `SELECT queue_name, id FROM pgboss_job WHERE ${where} ORDER BY rowid`,
          )
          .all(...values);
        for (const row of selected) {
          JobSettler.#failOne(
            db,
            Row.readString(row, 'queue_name'),
            { id: Row.readString(row, 'id'), attempt: undefined, output },
            false,
            now,
          );
        }
      },
      { mode: 'immediate' },
    );
  }

  // failJobsByIdWithOutputs, or with forceTerminal deadLetterJobsByIdWithOutputs
  // (plans.js:2646-2672): each job its own output.
  static failWithOutputs(
    db: DatabaseSync,
    name: string,
    outcomes: JobOutcome[],
    forceTerminal: boolean,
    now: Date,
  ): void {
    JobSettler.#failEach(
      db,
      name,
      JobSettler.#serializeOutputs(outcomes),
      forceTerminal,
      now,
    );
  }

  // Every output of a group is serialized before its statement runs
  // (manager.js:412, 422, 447, 451).
  static #serializeOutputs(outcomes: JobOutcome[]) {
    const outputs = CompletionData.serializeAll(
      outcomes.map(({ output }) => output),
    );
    return outcomes.map(({ id, retryCount }, index) => ({
      id,
      attempt: retryCount,
      output: outputs[index] ?? null,
    }));
  }

  static #failEach(
    db: DatabaseSync,
    name: string,
    settles: Settle[],
    forceTerminal: boolean,
    now: Date,
  ): string[] {
    const settled = JobSettler.#settleEach(db, settles, (settle) =>
      JobSettler.#failOne(db, name, settle, forceTerminal, now),
    );
    return [...settled];
  }

  // One transaction over the ids; the set holds those settleOne reports it
  // touched, by index into ids.
  static #settleEach<T extends { id: string }>(
    db: DatabaseSync,
    items: T[],
    settleOne: (item: T) => boolean,
  ): Set<string> {
    const settled = new Set<string>();
    transaction(
      db,
      () => {
        for (const item of items) {
          if (settleOne(item)) {
            settled.add(item.id);
          }
        }
      },
      { mode: 'immediate' },
    );
    return settled;
  }

  static #failOne(
    db: DatabaseSync,
    name: string,
    { id, attempt, output }: Settle,
    forceTerminal: boolean,
    now: Date,
  ): boolean {
    const fenced = attempt !== undefined;
    const row = db
      .prepare(
        `SELECT * FROM pgboss_job
        WHERE queue_name = ? AND id = ? AND state IN ('created', 'retry', 'active')
          ${fenced ? ATTEMPT_FENCE : ''}`,
      )
      .get(name, id, ...(fenced ? [attempt] : []));

    if (!row) {
      return false;
    }
    const job = JobRows.decode(row);
    const settle = db.prepare(
      `UPDATE pgboss_job
      SET state = ?,
        start_after = ?,
        completed_on = ?,
        failed_on = ?,
        output = ?,
        heartbeat_on = NULL,
        lease_expires_on = NULL
      WHERE queue_name = ? AND id = ?`,
    );
    const isoNow = SqlValues.asIso(now);

    // failJobsBody (node_modules/pg-boss/dist/plans.js:2430-2645): retry while
    // attempts remain, or with forceTerminal fail at once with the retry's
    // start_after (2431-2439, 2494-2503); a row the key's unique index refuses
    // fails for good instead (2529, 2607), keeping its start_after. With the
    // attempts spent, the CASEs compute that same failed row.
    if (job.retry_count < job.retry_limit) {
      const completedOn = forceTerminal ? isoNow : null;
      const landed = JobSettler.#unlessRefused(() =>
        settle.run(
          forceTerminal ? 'failed' : 'retry',
          SqlValues.asIso(JobSettler.#nextRetryStartAfter(job, now)),
          completedOn,
          completedOn,
          output,
          name,
          id,
        ),
      );
      if (landed) {
        if (forceTerminal) {
          JobSettler.#deadLetter(db, job, output, now);
        }
        return true;
      }
    }
    try {
      settle.run('failed', job.start_after, isoNow, isoNow, output, name, id);
    } catch (error) {
      // The failed row has no ON CONFLICT (2532-2609): only key_strict_fifo's
      // job_i8 holds failed jobs, and its refusal rolls the call back.
      if (
        Database.isUniqueViolation(error) &&
        job.policy === policies.key_strict_fifo
      ) {
        throw new DatabaseError(
          'duplicate key value violates unique constraint "job_common_i8"',
          '23505',
        );
      }
      throw error;
    }
    JobSettler.#deadLetter(db, job, output, now);
    return true;
  }

  // ON CONFLICT DO NOTHING (plans.js:2529): false when a unique index refused
  // the write.
  static #unlessRefused(write: () => unknown): boolean {
    try {
      write();
      return true;
    } catch (error) {
      if (Database.isUniqueViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  // plans.js:2494-2503: retry_delay seconds, or with backoff
  // max(retry_delay, 1)·2^e/2·(1 + random()) for e = min(16, retry_count + 1),
  // capped by retry_delay_max when one is set.
  static #nextRetryStartAfter(row: JobRow, now: Date): Date {
    if (!row.retry_backoff) {
      return SqlValues.addSeconds(now, row.retry_delay_seconds);
    }
    const half = 2 ** Math.min(16, row.retry_count + 1) / 2;
    const backoff =
      Math.max(row.retry_delay_seconds, 1) * (half + half * Math.random());
    const cap = row.retry_delay_max_seconds;
    return SqlValues.addSeconds(
      now,
      cap === null ? backoff : Math.min(cap, backoff),
    );
  }

  // plans.js:2615-2643: a job that ends failed is copied into its dead letter
  // queue as a new job with that queue's retry settings, retention, expiry,
  // deletion and heartbeat, the job's data, priority, key and group, and its
  // lineage.
  static #deadLetter(
    db: DatabaseSync,
    job: JobRow,
    output: string | null,
    now: Date,
  ): void {
    if (job.dead_letter === null) {
      return;
    }
    const found = db
      .prepare('SELECT * FROM pgboss_queue WHERE name = ?')
      .get(job.dead_letter);
    if (found === undefined) {
      return;
    }
    const queue = QueueRows.decode(found);
    db.prepare(
      `INSERT INTO pgboss_job (
        id, queue_name, data, policy, priority, retry_limit, retry_backoff,
        retry_delay_seconds, start_after, created_on, keep_until,
        retention_seconds, deletion_seconds, expire_seconds, singleton_key,
        group_id, group_tier, heartbeat_seconds, source_name, source_id,
        source_created_on, source_retry_count, source_output, source_root_id
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      queue.name,
      job.data,
      job.priority,
      queue.retry_limit,
      queue.retry_backoff,
      queue.retry_delay_seconds,
      SqlValues.asIso(now),
      SqlValues.asIso(now),
      SqlValues.asIso(SqlValues.addSeconds(now, queue.retention_seconds)),
      queue.retention_seconds,
      queue.deletion_seconds,
      queue.expire_seconds,
      job.singleton_key,
      job.group_id,
      job.group_tier,
      queue.heartbeat_seconds,
      job.queue_name,
      job.id,
      job.created_on,
      job.retry_count,
      output,
      job.source_root_id ?? job.id,
    );
  }

  static cancel(
    db: DatabaseSync,
    name: string,
    ids: string[],
    attempts: number[] | undefined,
    now: Date,
  ): string[] {
    const uuids = ids.map((jobId) => Uuid.canonical(jobId));
    const isoNow = SqlValues.asIso(now);
    const statement = db.prepare(
      `UPDATE pgboss_job
      SET state = 'cancelled', completed_on = ?, cancelled_on = ?
      WHERE queue_name = ?
        AND id = ?
        AND state IN ('created', 'retry', 'active')
        ${attempts ? ATTEMPT_FENCE : ''}`,
    );

    const targets = uuids.map((id, index) => ({
      id,
      fence: attempts ? [attempts[index] ?? null] : [],
    }));
    const settled = JobSettler.#settleEach(db, targets, ({ id, fence }) => {
      const { changes } = statement.run(isoNow, isoNow, name, id, ...fence);
      return Number(changes) > 0;
    });

    return [...settled];
  }

  // restoreJobs (node_modules/pg-boss/dist/plans.js:2201-2209): back to
  // created whatever the state, unfenced, and with started_on cleared so the
  // next claim spends no attempt.
  static restore(db: DatabaseSync, name: string, ids: string[]): void {
    db.prepare(
      `UPDATE pgboss_job
      SET state = 'created', started_on = NULL, heartbeat_on = NULL
      WHERE queue_name = ? AND id IN (${ids.map(() => '?').join(', ')})`,
    ).run(name, ...ids);
  }

  // pg-boss's touch() with the attempts the heartbeat holds (manager.js:
  // 1994-2002, plans.js:2387-2400): the ids whose heartbeat it refreshed.
  static touch(
    db: DatabaseSync,
    name: string,
    held: JobRow[],
    now: Date,
  ): Set<string> {
    const isoNow = SqlValues.asIso(now);
    const statement = db.prepare(
      `UPDATE pgboss_job SET heartbeat_on = ?
      WHERE queue_name = ? AND id = ? ${ATTEMPT_FENCE}`,
    );
    return JobSettler.#settleEach(db, held, ({ id, retry_count }) => {
      const { changes } = statement.run(isoNow, name, id, retry_count);
      return Number(changes) > 0;
    });
  }
}
