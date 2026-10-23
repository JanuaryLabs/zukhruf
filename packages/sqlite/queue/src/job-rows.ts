import type { Job, QueuePolicy, SendOptions } from 'pg-boss';

import type { FoundJob } from './job-queue.ts';
import { NaiveTimestamp } from './naive-timestamp.ts';
import { QueueRows } from './queue-rows.ts';
import { Row } from './rows.ts';
import type { SqliteRow } from './rows.ts';
import { SqlValues } from './sql-values.ts';

export type JobRow = {
  id: string;
  queue_name: string;
  data: string;
  state: FoundJob<unknown>['state'];
  policy: QueuePolicy | null;
  priority: number;
  retry_limit: number;
  retry_count: number;
  retry_delay_seconds: number;
  retry_backoff: number;
  retry_delay_max_seconds: number | null;
  start_after: string;
  singleton_key: string | null;
  singleton_on: string | null;
  expire_seconds: number;
  retention_seconds: number;
  deletion_seconds: number;
  heartbeat_seconds: number | null;
  heartbeat_on: string | null;
  lease_expires_on: string | null;
  created_on: string;
  started_on: string | null;
  completed_on: string | null;
  keep_until: string;
  cancelled_on: string | null;
  failed_on: string | null;
  output: string | null;
  error: string | null;
  dead_letter: string | null;
  group_id: string | null;
  group_tier: string | null;
  source_name: string | null;
  source_id: string | null;
  source_created_on: string | null;
  source_retry_count: number | null;
  source_output: string | null;
  source_root_id: string | null;
};

export class JobRows {
  static #readState(row: SqliteRow): FoundJob<unknown>['state'] {
    const state = Row.readString(row, 'state');
    if (
      state === 'created' ||
      state === 'retry' ||
      state === 'active' ||
      state === 'completed' ||
      state === 'cancelled' ||
      state === 'failed'
    ) {
      return state;
    }

    throw new Error(`Unsupported SQLite job state: ${state}`);
  }

  // The job as pg-boss sends it: JSON.stringify([job]) of #toJobPayload's
  // fields, in its order (node_modules/pg-boss/dist/manager.js:1208-1230,
  // 1242).
  static payload(name: string, data: unknown, options: SendOptions): string {
    const {
      id = null,
      priority,
      startAfter,
      singletonKey = null,
      singletonSeconds,
      expireInSeconds,
      deleteAfterSeconds,
      retentionSeconds,
      retryLimit,
      retryDelay,
      retryBackoff,
      retryDelayMax,
      heartbeatSeconds,
      group,
      deadLetter = null,
    } = options;
    return JSON.stringify([
      {
        id,
        name,
        data,
        priority,
        startAfter,
        singletonKey,
        singletonSeconds,
        singletonOffset: 0,
        groupId: group?.id ?? null,
        groupTier: group?.tier ?? null,
        expireInSeconds,
        deleteAfterSeconds,
        retentionSeconds,
        retryLimit,
        retryDelay,
        retryBackoff,
        retryDelayMax,
        heartbeatSeconds,
        deadLetter,
      },
    ]);
  }

  static decode(value: unknown): JobRow {
    const row = Row.parse(value, 'job');
    return {
      id: Row.readString(row, 'id'),
      queue_name: Row.readString(row, 'queue_name'),
      data: Row.readString(row, 'data'),
      state: JobRows.#readState(row),
      policy: row.policy === null ? null : QueueRows.readPolicy(row),
      priority: Row.readNumber(row, 'priority'),
      retry_limit: Row.readNumber(row, 'retry_limit'),
      retry_count: Row.readNumber(row, 'retry_count'),
      retry_delay_seconds: Row.readNumber(row, 'retry_delay_seconds'),
      retry_backoff: Row.readNumber(row, 'retry_backoff'),
      retry_delay_max_seconds: Row.readNullableNumber(
        row,
        'retry_delay_max_seconds',
      ),
      start_after: Row.readString(row, 'start_after'),
      singleton_key: Row.readNullableString(row, 'singleton_key'),
      singleton_on: Row.readNullableString(row, 'singleton_on'),
      expire_seconds: Row.readNumber(row, 'expire_seconds'),
      retention_seconds: Row.readNumber(row, 'retention_seconds'),
      deletion_seconds: Row.readNumber(row, 'deletion_seconds'),
      heartbeat_seconds: Row.readNullableNumber(row, 'heartbeat_seconds'),
      heartbeat_on: Row.readNullableString(row, 'heartbeat_on'),
      lease_expires_on: Row.readNullableString(row, 'lease_expires_on'),
      created_on: Row.readString(row, 'created_on'),
      started_on: Row.readNullableString(row, 'started_on'),
      completed_on: Row.readNullableString(row, 'completed_on'),
      keep_until: Row.readString(row, 'keep_until'),
      cancelled_on: Row.readNullableString(row, 'cancelled_on'),
      failed_on: Row.readNullableString(row, 'failed_on'),
      output: Row.readNullableString(row, 'output'),
      error: Row.readNullableString(row, 'error'),
      dead_letter: Row.readNullableString(row, 'dead_letter'),
      group_id: Row.readNullableString(row, 'group_id'),
      group_tier: Row.readNullableString(row, 'group_tier'),
      source_name: Row.readNullableString(row, 'source_name'),
      source_id: Row.readNullableString(row, 'source_id'),
      source_created_on: Row.readNullableString(row, 'source_created_on'),
      source_retry_count: Row.readNullableNumber(row, 'source_retry_count'),
      source_output: Row.readNullableString(row, 'source_output'),
      source_root_id: Row.readNullableString(row, 'source_root_id'),
    };
  }

  static toFound(
    row: JobRow,
    signal: AbortSignal = new AbortController().signal,
  ): FoundJob<unknown> {
    const data: unknown = JSON.parse(row.data);

    return {
      id: row.id,
      name: row.queue_name,
      data,
      expireInSeconds: row.expire_seconds,
      heartbeatSeconds: row.heartbeat_seconds,
      signal,
      groupId: row.group_id,
      groupTier: row.group_tier,
      priority: row.priority,
      state: row.state,
      retryLimit: row.retry_limit,
      retryCount: row.retry_count,
      retryDelay: row.retry_delay_seconds,
      retryBackoff: Boolean(row.retry_backoff),
      retryDelayMax: row.retry_delay_max_seconds,
      startAfter: new Date(row.start_after),
      startedOn: SqlValues.parseNullableDate(row.started_on),
      singletonKey: row.singleton_key,
      singletonOn:
        row.singleton_on === null
          ? null
          : NaiveTimestamp.toLocal(row.singleton_on),
      deleteAfterSeconds: row.deletion_seconds,
      createdOn: new Date(row.created_on),
      completedOn: SqlValues.parseNullableDate(row.completed_on),
      keepUntil: new Date(row.keep_until),
      policy: row.policy,
      heartbeatOn: SqlValues.parseNullableDate(row.heartbeat_on),
      deadLetter: row.dead_letter,
      output: row.output === null ? null : JSON.parse(row.output),
      // This backend has no job dependencies (pg-boss's job_dependency table),
      // so no job is ever blocked or blocking.
      blocked: false,
      blocking: false,
      pendingDependencies: 0,
      // Filled only on a dead letter copy (plans.js:2615-2643).
      sourceName: row.source_name,
      sourceId: row.source_id,
      sourceCreatedOn: SqlValues.parseNullableDate(row.source_created_on),
      sourceRetryCount: row.source_retry_count,
      sourceOutput:
        row.source_output === null ? null : JSON.parse(row.source_output),
      sourceRootId: row.source_root_id,
    };
  }

  // A worker's job: pg-boss's minimal columns unless includeMetadata asks for
  // all of them (node_modules/pg-boss/dist/plans.js:591-620, 2028).
  static toJob(
    row: JobRow,
    includeMetadata: boolean,
    signal: AbortSignal,
  ): Job<unknown> {
    if (includeMetadata) {
      return JobRows.toFound(row, signal);
    }
    const data: unknown = JSON.parse(row.data);
    return {
      id: row.id,
      name: row.queue_name,
      data,
      retryCount: row.retry_count,
      expireInSeconds: row.expire_seconds,
      heartbeatSeconds: row.heartbeat_seconds,
      groupId: row.group_id,
      groupTier: row.group_tier,
      signal,
    };
  }
}
