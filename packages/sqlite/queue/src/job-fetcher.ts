import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { type GroupConcurrencyConfig, policies } from 'pg-boss';

import { transaction } from '@zukhruf/sqlite-transaction';

import { Database } from './database.ts';
import { JobRows } from './job-rows.ts';
import type { JobRow } from './job-rows.ts';
import { JobSettler } from './job-settler.ts';
import type { QueueRow } from './queue-rows.ts';
import { Row } from './rows.ts';
import { SqlValues } from './sql-values.ts';

// A piece of SQL with the values its placeholders bind, in text order.
type Fragment = [sql: string, ...values: SQLInputValue[]];

type Candidate = { row: JobRow; activeCount: number; groupLimit: number };

export class JobFetcher {
  // pg-boss's fetchNextJob (node_modules/pg-boss/dist/plans.js:2364-2569).
  static claim(
    db: DatabaseSync,
    queue: QueueRow,
    fetchOptions: {
      batchSize: number;
      ignoreStartAfter: boolean;
      minPriority: number | undefined;
      maxPriority: number | undefined;
      groupConcurrency: number | GroupConcurrencyConfig | undefined;
      ignoreGroups: string[] | undefined;
    },
    now: Date,
  ): JobRow[] {
    const { name, policy } = queue;
    const {
      batchSize,
      ignoreStartAfter,
      minPriority,
      maxPriority,
      groupConcurrency,
      ignoreGroups,
    } = fetchOptions;
    const isoNow = SqlValues.asIso(now);
    const singletonPolicy =
      policy === policies.singleton || policy === policies.stately;
    const singletonFetch = batchSize > 1 && singletonPolicy;
    const groups =
      groupConcurrency == null
        ? null
        : typeof groupConcurrency === 'number'
          ? { default: groupConcurrency }
          : groupConcurrency;

    const conditions: Fragment[] = [
      ['j.queue_name = ?', name],
      ["j.state IN ('created', 'retry')"],
    ];
    // plans.js:2453
    const dueBy = ignoreStartAfter ? null : isoNow;
    if (dueBy !== null) {
      conditions.push(['j.start_after <= ?', dueBy]);
    }
    if (policy === policies.key_strict_fifo) {
      conditions.push(...JobFetcher.#keyStrictFifoConditions(dueBy));
    }
    // A key whose active slot is taken offers no job, read live, not from the
    // stats the supervisor last wrote (12.37.1, #957: plans.js:2466-2478).
    if (singletonPolicy) {
      conditions.push([
        `NOT EXISTS (
          SELECT 1
          FROM pgboss_job singleton_probe
          WHERE singleton_probe.queue_name = j.queue_name
            AND singleton_probe.state = 'active'
            AND singleton_probe.policy = ?
            AND COALESCE(singleton_probe.singleton_key, '') = COALESCE(j.singleton_key, '')
        )`,
        policy,
      ]);
    }
    // plans.js:2479
    if (ignoreGroups && ignoreGroups.length > 0) {
      conditions.push([
        '(j.group_id IS NULL OR j.group_id NOT IN (SELECT value FROM json_each(?)))',
        JSON.stringify(ignoreGroups),
      ]);
    }
    if (minPriority !== undefined) {
      conditions.push(['j.priority >= ?', minPriority]);
    }
    if (maxPriority !== undefined) {
      conditions.push(['j.priority <= ?', maxPriority]);
    }
    // A group already at its limit offers no job (plans.js:2413-2425). With
    // a default of 1 and no tiers pg-boss asks NOT EXISTS instead of counting
    // (2379, 2415-2423), which keeps the same jobs.
    if (groups) {
      conditions.push([
        '(j.group_id IS NULL OR COALESCE(a.active_cnt, 0) < COALESCE(t.value, d.group_default))',
      ]);
    }

    // Always priority, then creation (plans.js:2484-2507), and the LIMIT
    // before any key or group ranking. pg-boss leaves created_on ties to
    // index order, which tracks insertion; rowid is that order here, where
    // millisecond created_on ties often.
    const [sql, ...values] = JobFetcher.#join(
      [
        [
          groups
            ? `SELECT j.*,
              COALESCE(a.active_cnt, 0) AS active_cnt,
              COALESCE(t.value, d.group_default) AS group_limit`
            : 'SELECT j.*',
        ],
        ['FROM pgboss_job j'],
        groups ? JobFetcher.#groupJoins(name, groups) : [''],
        JobFetcher.#join(conditions, ' AND ', 'WHERE '),
        ['ORDER BY j.priority DESC, j.created_on, j.rowid'],
        ['LIMIT ?', batchSize],
      ],
      '\n',
    );
    // On Postgres, FOR UPDATE OF j SKIP LOCKED gives each job to one claim
    // (plans.js:2410), and one statement reads the candidates and the group
    // counts and claims the jobs (2549-2565). SQLite has no row locks. Thus
    // the transaction takes the write lock before the read: no other
    // connection of the file claims between the read and the UPDATE.
    try {
      return transaction(
        db,
        () => {
          const candidates: Candidate[] = db
            .prepare(sql)
            .all(...values)
            .map((value) => {
              const row = Row.parse(value, 'job');
              return {
                row: JobRows.decode(row),
                activeCount: groups ? Row.readNumber(row, 'active_cnt') : 0,
                groupLimit: groups ? Row.readNumber(row, 'group_limit') : 0,
              };
            });
          // A batch on a singleton or stately queue claims one job per
          // singleton_key, keyless jobs sharing one (plans.js:2367-2368,
          // 2508-2512, 2563).
          const claimedKeys = new Set<string | null>();
          const firstOfKeys = singletonFetch
            ? candidates.filter(({ row }) => {
                const isFirstOfKey = !claimedKeys.has(row.singleton_key);
                claimedKeys.add(row.singleton_key);
                return isFirstOfKey;
              })
            : candidates;
          // pg-boss's RETURNING carries no ORDER BY (plans.js:2556-2565); on
          // an analyzed Postgres a batch comes back in claim order, which is
          // the order of the candidates. The claim gives only the rows that
          // its UPDATE changed, as RETURNING does.
          const statement = db.prepare(
            `UPDATE pgboss_job
          SET state = 'active',
            started_on = ?,
            heartbeat_on = ?,
            lease_expires_on = ?,
            retry_count = CASE
              WHEN started_on IS NOT NULL THEN retry_count + 1
              ELSE retry_count
            END
          WHERE queue_name = ? AND id = ? AND state IN ('created', 'retry')
          RETURNING *`,
          );
          const taken = (
            groups ? JobFetcher.#withinGroupLimits(firstOfKeys) : firstOfKeys
          ).flatMap(({ row }) => {
            const leaseExpiresOn =
              row.heartbeat_seconds === null
                ? null
                : SqlValues.asIso(
                    SqlValues.addSeconds(now, row.heartbeat_seconds),
                  );
            const claimed = statement.get(
              isoNow,
              isoNow,
              leaseExpiresOn,
              name,
              row.id,
            );
            return claimed === undefined ? [] : [JobRows.decode(claimed)];
          });
          return groups
            ? JobFetcher.#giveBackOverLimit(db, name, groups, taken)
            : taken;
        },
        { mode: 'immediate' },
      );
    } catch (error) {
      // The one fetch error pg-boss tolerates: a policy index refusing the
      // claim, which it treats as an empty fetch (manager.js:1900-1906).
      if (Database.isUniqueViolation(error)) {
        return [];
      }
      throw error;
    }
  }

  // pg-boss counts the active jobs of each claimed group again once its claim
  // committed, and gives back, from the end of the batch, each job whose
  // group is over that job's own tier limit (12.38.1: manager.js:1908-1937,
  // plans.js:2778). No claim races here, but the claim ranks a group across
  // its tiers, so a batch can still hold a job past its own tier. pg-boss's
  // fetch again after giving everything back needs a race, and at least a
  // tier's limit of each group stays here.
  static #giveBackOverLimit(
    db: DatabaseSync,
    name: string,
    groups: GroupConcurrencyConfig,
    rows: JobRow[],
  ): JobRow[] {
    const grouped = rows.flatMap((row) => row.group_id ?? []);
    if (grouped.length === 0) {
      return rows;
    }
    const active = new Map(
      db
        .prepare(
          `SELECT group_id, COUNT(*) AS count FROM pgboss_job
          WHERE queue_name = ? AND state = 'active'
            AND group_id IN (SELECT value FROM json_each(?))
          GROUP BY group_id`,
        )
        .all(name, JSON.stringify(grouped))
        .map((row) => [
          Row.readString(row, 'group_id'),
          Row.readNumber(row, 'count'),
        ]),
    );
    const excess: string[] = [];
    for (const row of rows.toReversed()) {
      if (row.group_id === null) {
        continue;
      }
      const count = active.get(row.group_id) ?? 0;
      if (count > (groups.tiers?.[String(row.group_tier)] ?? groups.default)) {
        excess.push(row.id);
        active.set(row.group_id, count - 1);
      }
    }
    if (excess.length === 0) {
      return rows;
    }
    const givenBack = JobFetcher.#giveBack(db, name, excess);
    return rows.filter((row) => !givenBack.has(row.id));
  }

  // #giveBack (manager.js:1947-1975): a policy index can refuse a job its way
  // back, a stately key whose created slot filled after the claim, and one
  // refusal fails the statement, so each id is then tried alone; the refused
  // ones stay active and run. SQLite backs out only the refused statement.
  static #giveBack(db: DatabaseSync, name: string, ids: string[]): Set<string> {
    try {
      JobSettler.restore(db, name, ids);
      return new Set(ids);
    } catch (error) {
      if (!Database.isUniqueViolation(error)) {
        throw error;
      }
    }
    const givenBack = new Set<string>();
    if (ids.length === 1) {
      return givenBack;
    }
    for (const id of ids) {
      try {
        JobSettler.restore(db, name, [id]);
        givenBack.add(id);
      } catch (error) {
        if (!Database.isUniqueViolation(error)) {
          throw error;
        }
      }
    }
    return givenBack;
  }

  static #join(
    fragments: Fragment[],
    separator: string,
    prefix = '',
  ): Fragment {
    return [
      prefix + fragments.map(([sql]) => sql).join(separator),
      ...fragments.flatMap(([, ...values]) => values),
    ];
  }

  // A key_strict_fifo job is claimed only as its key's head, a retry job
  // first ('retry' sorts after 'created' as text, as in pg-boss's enum),
  // and only while no sibling is active, retrying or failed
  // (plans.js:2432-2442, 2454-2464). pg-boss breaks created_on ties by id,
  // which only decides under a frozen clock: Postgres's microsecond now()
  // keeps sends apart. Millisecond created_on ties here, so insertion order
  // (rowid) breaks ties, as Postgres's timestamps would. With
  // ignoreStartAfter, a deferred job can be the head (plans.js:2440).
  static #keyStrictFifoConditions(dueBy: string | null): Fragment[] {
    return [
      [
        `j.id = (
          SELECT h.id FROM pgboss_job h
          WHERE h.queue_name = j.queue_name
            AND h.singleton_key = j.singleton_key
            AND h.state IN ('created', 'retry')
            AND h.policy = '${policies.key_strict_fifo}'
            ${dueBy === null ? '' : 'AND h.start_after <= ?'}
          ORDER BY h.state DESC, h.created_on, h.rowid
          LIMIT 1
        )`,
        ...(dueBy === null ? [] : [dueBy]),
      ],
      [
        `NOT EXISTS (
          SELECT 1 FROM pgboss_job b
          WHERE b.queue_name = j.queue_name
            AND b.singleton_key = j.singleton_key
            AND b.state IN ('active', 'retry', 'failed')
            AND b.policy = '${policies.key_strict_fifo}'
            AND b.id <> j.id
        )`,
      ],
    ];
  }

  // Each candidate's group limit, its tier's or else the default
  // (plans.js:2382-2384), and its group's active jobs of every tier
  // (2395-2407), so the WHERE and the ranking read the same two numbers.
  static #groupJoins(name: string, groups: GroupConcurrencyConfig): Fragment {
    return [
      `LEFT JOIN (
        SELECT group_id, COUNT(*) AS active_cnt
        FROM pgboss_job
        WHERE queue_name = ? AND state = 'active' AND group_id IS NOT NULL
        GROUP BY group_id
      ) a ON a.group_id = j.group_id
      LEFT JOIN json_each(?) t ON t.key = j.group_tier
      CROSS JOIN (SELECT ? AS group_default) d`,
      name,
      JSON.stringify(groups.tiers ?? {}),
      groups.default,
    ];
  }

  // group_ranking and group_filtered (plans.js:2518-2531): within each group,
  // by id, a job is claimed while its group's active jobs and those ranked
  // before it stay under its limit. Canonical uuid text sorts as Postgres
  // orders uuids.
  static #withinGroupLimits(candidates: Candidate[]): Candidate[] {
    const ranks = new Map<string, number>();
    const claimed = new Set<Candidate>();
    const byId = candidates.toSorted((a, b) => {
      if (a.row.id < b.row.id) {
        return -1;
      }
      return a.row.id > b.row.id ? 1 : 0;
    });
    for (const candidate of byId) {
      const groupId = candidate.row.group_id;
      if (groupId === null) {
        claimed.add(candidate);
        continue;
      }
      const rank = (ranks.get(groupId) ?? 0) + 1;
      ranks.set(groupId, rank);
      if (candidate.activeCount + rank <= candidate.groupLimit) {
        claimed.add(candidate);
      }
    }
    return candidates.filter((candidate) => claimed.has(candidate));
  }
}
