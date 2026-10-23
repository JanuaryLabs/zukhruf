import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { type GroupConcurrencyConfig, policies } from 'pg-boss';

import { transaction } from '@zukhruf/sqlite-transaction';

import { Database } from './database.ts';
import { JobRows } from './job-rows.ts';
import type { JobRow } from './job-rows.ts';
import type { QueueRow } from './queue-rows.ts';
import { Row } from './rows.ts';
import { SqlValues } from './sql-values.ts';

// A piece of SQL with the values its placeholders bind, in text order.
type Fragment = [sql: string, ...values: SQLInputValue[]];

type Candidate = { row: JobRow; activeCount: number; groupLimit: number };

export class JobFetcher {
  // pg-boss's fetchNextJob as work() calls it (node_modules/pg-boss/dist/
  // plans.js:1839-2032): work() never forwards ignoreStartAfter
  // (manager.js:951-956), so due jobs only.
  static claim(
    db: DatabaseSync,
    queue: QueueRow,
    fetchOptions: {
      batchSize: number;
      minPriority: number | undefined;
      maxPriority: number | undefined;
      groupConcurrency: number | GroupConcurrencyConfig | undefined;
      ignoreGroups: string[] | undefined;
      ignoreSingletons: (string | null)[] | null;
    },
    now: Date,
  ): JobRow[] {
    const { name, policy } = queue;
    const {
      batchSize,
      minPriority,
      maxPriority,
      groupConcurrency,
      ignoreGroups,
      ignoreSingletons,
    } = fetchOptions;
    const isoNow = SqlValues.asIso(now);
    const singletonFetch =
      batchSize > 1 &&
      (policy === policies.singleton || policy === policies.stately);
    const groups =
      groupConcurrency == null
        ? null
        : typeof groupConcurrency === 'number'
          ? { default: groupConcurrency }
          : groupConcurrency;

    const conditions: Fragment[] = [
      ['j.queue_name = ?', name],
      ["j.state IN ('created', 'retry')"],
      ['j.start_after <= ?', isoNow],
    ];
    if (policy === policies.key_strict_fifo) {
      conditions.push(...JobFetcher.#keyStrictFifoConditions(isoNow));
    }
    // plans.js:1941, with a null key read as '' on both sides (1794)
    if (ignoreSingletons && ignoreSingletons.length > 0) {
      conditions.push([
        "COALESCE(j.singleton_key, '') NOT IN (SELECT value FROM json_each(?))",
        JSON.stringify(ignoreSingletons.map((key) => key ?? '')),
      ]);
    }
    // plans.js:1942
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
    // A group already at its limit offers no job (plans.js:1888-1900). With
    // a default of 1 and no tiers pg-boss asks NOT EXISTS instead of counting
    // (1854, 1890-1898), which keeps the same jobs.
    if (groups) {
      conditions.push([
        '(j.group_id IS NULL OR COALESCE(a.active_cnt, 0) < COALESCE(t.value, d.group_default))',
      ]);
    }

    // Always priority, then creation (plans.js:1947-1970), and the LIMIT
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
    // singleton_key, keyless jobs sharing one (plans.js:1842, 1971-1975, 2026).
    const claimedKeys = new Set<string | null>();
    const firstOfKeys = singletonFetch
      ? candidates.filter(({ row }) => {
          const isFirstOfKey = !claimedKeys.has(row.singleton_key);
          claimedKeys.add(row.singleton_key);
          return isFirstOfKey;
        })
      : candidates;
    const rows = (
      groups ? JobFetcher.#withinGroupLimits(firstOfKeys) : firstOfKeys
    ).map(({ row }) => row);

    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => row.id);
    try {
      transaction(
        db,
        () => {
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
          WHERE queue_name = ? AND id = ? AND state IN ('created', 'retry')`,
          );
          for (const row of rows) {
            const leaseExpiresOn =
              row.heartbeat_seconds === null
                ? null
                : SqlValues.asIso(
                    SqlValues.addSeconds(now, row.heartbeat_seconds),
                  );
            statement.run(isoNow, isoNow, leaseExpiresOn, name, row.id);
          }
        },
        { mode: 'immediate' },
      );
    } catch (error) {
      // The one fetch error pg-boss tolerates: a policy index refusing the
      // claim, which it treats as an empty fetch (manager.js:1580-1586).
      if (Database.isUniqueViolation(error)) {
        return [];
      }
      throw error;
    }

    return db
      .prepare(
        // pg-boss's RETURNING carries no ORDER BY (plans.js:2019-2028); on an
        // analyzed Postgres a batch comes back in claim order, which this
        // keeps.
        `SELECT * FROM pgboss_job
        WHERE queue_name = ? AND id IN (${ids.map(() => '?').join(', ')})
        ORDER BY priority DESC, created_on, rowid`,
      )
      .all(name, ...ids)
      .map(JobRows.decode);
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
  // (plans.js:1907-1917, 1929-1939). pg-boss breaks created_on ties by id,
  // which only decides under a frozen clock: Postgres's microsecond now()
  // keeps sends apart. Millisecond created_on ties here, so insertion order
  // (rowid) breaks ties, as Postgres's timestamps would.
  static #keyStrictFifoConditions(isoNow: string): Fragment[] {
    return [
      [
        `j.id = (
          SELECT h.id FROM pgboss_job h
          WHERE h.queue_name = j.queue_name
            AND h.singleton_key = j.singleton_key
            AND h.state IN ('created', 'retry')
            AND h.policy = '${policies.key_strict_fifo}'
            AND h.start_after <= ?
          ORDER BY h.state DESC, h.created_on, h.rowid
          LIMIT 1
        )`,
        isoNow,
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
  // (plans.js:1857-1859), and its group's active jobs of every tier
  // (1870-1882), so the WHERE and the ranking read the same two numbers.
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

  // group_ranking and group_filtered (plans.js:1981-1994): within each group,
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
