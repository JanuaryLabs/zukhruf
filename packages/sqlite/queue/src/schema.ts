import { Declaration } from '@zukhruf/sqlite-drift';

// The queue's tables and indexes. start() makes a file store them as declared
// and keeps the rows of each table it rebuilds, so the jobs and schedules of a
// file an earlier release made survive (docs/adr/0004).
export const queueSchema = new Declaration(
  [
    `CREATE TABLE pgboss_queue (
    name TEXT PRIMARY KEY,
    policy TEXT NOT NULL DEFAULT 'standard',
    retry_limit INTEGER NOT NULL DEFAULT 2 CHECK (retry_limit >= 0),
    retry_delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK (retry_delay_seconds >= 0),
    retry_backoff INTEGER NOT NULL DEFAULT 0 CHECK (retry_backoff IN (0, 1)),
    retry_delay_max_seconds INTEGER CHECK (retry_delay_max_seconds IS NULL OR retry_delay_max_seconds >= 0),
    expire_seconds INTEGER NOT NULL DEFAULT 900 CHECK (expire_seconds >= 1),
    retention_seconds INTEGER NOT NULL DEFAULT 1209600 CHECK (retention_seconds >= 1),
    deletion_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (deletion_seconds >= 0),
    heartbeat_seconds INTEGER CHECK (heartbeat_seconds IS NULL OR heartbeat_seconds >= 10),
    -- queue_dead_letter_fkey (node_modules/pg-boss/dist/plans.js:356)
    dead_letter TEXT REFERENCES pgboss_queue(name),
    warning_queue_size INTEGER NOT NULL DEFAULT 0 CHECK (warning_queue_size >= 0),
    notify INTEGER NOT NULL DEFAULT 0 CHECK (notify IN (0, 1)),
    -- pg-boss's own table for the queue's jobs (node_modules/pg-boss/dist/
    -- plans.js:357-358), which getQueues gives; the jobs stay in pgboss_job.
    partition INTEGER NOT NULL DEFAULT 0 CHECK (partition IN (0, 1)),
    -- The monitor's counts and claim stamps (node_modules/pg-boss/dist/
    -- plans.js:359-383); singletons_active is a JSON array of keys, nulls
    -- included, or NULL when no singleton or stately job is active.
    deferred_count INTEGER NOT NULL DEFAULT 0,
    queued_count INTEGER NOT NULL DEFAULT 0,
    ready_count INTEGER NOT NULL DEFAULT 0,
    active_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL DEFAULT 0,
    -- The completed and cancelled jobs the queue holds, and the time they
    -- were counted to; total_count is the live jobs plus them. Both NULL
    -- until the queue's first maintenance pass (12.38.0: plans.js:335-342).
    retained_count INTEGER,
    retained_on TEXT,
    singletons_active TEXT,
    monitor_claim_on TEXT,
    monitor_on TEXT,
    maintain_on TEXT,
    created_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
    `CREATE TABLE pgboss_job (
    id TEXT NOT NULL,
    queue_name TEXT NOT NULL REFERENCES pgboss_queue(name) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'created' CHECK (state IN ('created', 'retry', 'active', 'completed', 'cancelled', 'failed')),
    -- A dead letter copy carries none (plans.js:3384-3413).
    policy TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    retry_limit INTEGER NOT NULL DEFAULT 2 CHECK (retry_limit >= 0),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    retry_delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK (retry_delay_seconds >= 0),
    retry_backoff INTEGER NOT NULL DEFAULT 0 CHECK (retry_backoff IN (0, 1)),
    retry_delay_max_seconds INTEGER CHECK (retry_delay_max_seconds IS NULL OR retry_delay_max_seconds >= 0),
    start_after TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    singleton_key TEXT,
    singleton_on TEXT,
    expire_seconds INTEGER NOT NULL DEFAULT 900 CHECK (expire_seconds >= 1),
    retention_seconds INTEGER NOT NULL DEFAULT 1209600 CHECK (retention_seconds >= 1),
    deletion_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (deletion_seconds >= 0),
    heartbeat_seconds INTEGER CHECK (heartbeat_seconds IS NULL OR heartbeat_seconds >= 10),
    heartbeat_on TEXT,
    lease_expires_on TEXT,
    created_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_on TEXT,
    completed_on TEXT,
    keep_until TEXT NOT NULL,
    cancelled_on TEXT,
    failed_on TEXT,
    output TEXT,
    error TEXT,
    -- dlq_fkey, RESTRICT (plans.js:1251-1254)
    dead_letter TEXT REFERENCES pgboss_queue(name),
    group_id TEXT,
    group_tier TEXT,
    source_name TEXT,
    source_id TEXT,
    source_created_on TEXT,
    source_retry_count INTEGER,
    source_output TEXT,
    source_root_id TEXT,
    -- pg-boss keys a job by queue and id (node_modules/pg-boss/dist/plans.js:
    -- 1244-1246), so the same id may live in two queues.
    PRIMARY KEY (queue_name, id)
  )`,
    `CREATE TABLE pgboss_schedule (
    -- node_modules/pg-boss/dist/plans.js:404-421, without last_job_id.
    queue_name TEXT NOT NULL REFERENCES pgboss_queue(name) ON DELETE CASCADE,
    key TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'cron' CHECK (kind IN ('cron', 'rrule')),
    cron TEXT NOT NULL,
    timezone TEXT DEFAULT 'UTC',
    data TEXT,
    options TEXT,
    created_on TEXT NOT NULL,
    updated_on TEXT NOT NULL,
    -- The latest occurrence sent for this definition, not when it was sent:
    -- every occurrence at or before it has been sent or is not owed
    -- (12.39.0: plans.js:398-402, 417). NULL on a row an earlier release
    -- kept, as pg-boss's migration leaves it (migrationStore.js:2340).
    sent_on TEXT,
    PRIMARY KEY (queue_name, key)
  )`,
    // One row (node_modules/pg-boss/dist/plans.js:311-321): the release that
    // made the schema (docs/adr/0006), and the instance-wide cron claim, when
    // a pass last ran (plans.js:1503-1513).
    `CREATE TABLE pgboss_version (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version TEXT,
    cron_on TEXT
  )`,
    `CREATE INDEX pgboss_job_fetch_i
    ON pgboss_job (queue_name, state, priority DESC, start_after, created_on)`,
    `CREATE INDEX pgboss_job_lease_i
    ON pgboss_job (lease_expires_on)
    WHERE state = 'active' AND lease_expires_on IS NOT NULL`,
    // pg-boss's policy and throttle indexes, each cited by its name and line in
    // node_modules/pg-boss/dist/plans.js. Its `state <= active` compares enum
    // order, which is created, retry, active.
    // job_i1, plans.js:1255
    `CREATE UNIQUE INDEX pgboss_job_short_i
    ON pgboss_job (queue_name, COALESCE(singleton_key, ''))
    WHERE state = 'created' AND policy = 'short'`,
    // job_i2, plans.js:1258
    `CREATE UNIQUE INDEX pgboss_job_singleton_i
    ON pgboss_job (queue_name, COALESCE(singleton_key, ''))
    WHERE state = 'active' AND policy = 'singleton'`,
    // job_i3, plans.js:1261
    `CREATE UNIQUE INDEX pgboss_job_stately_i
    ON pgboss_job (queue_name, state, COALESCE(singleton_key, ''))
    WHERE state IN ('created', 'retry', 'active') AND policy = 'stately'`,
    // job_i4, plans.js:1264
    `CREATE UNIQUE INDEX pgboss_job_throttle_i
    ON pgboss_job (queue_name, singleton_on, COALESCE(singleton_key, ''))
    WHERE state <> 'cancelled' AND singleton_on IS NOT NULL`,
    // job_i6, plans.js:1294
    `CREATE UNIQUE INDEX pgboss_job_exclusive_i
    ON pgboss_job (queue_name, COALESCE(singleton_key, ''))
    WHERE state IN ('created', 'retry', 'active') AND policy = 'exclusive'`,
    // job_i8, plans.js:1297
    `CREATE UNIQUE INDEX pgboss_job_key_strict_fifo_i
    ON pgboss_job (queue_name, singleton_key)
    WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'`,
    // job_i10, plans.js:1313: each key's queued jobs in head order, so a claim
    // finds a key's head without scanning the queue. SQLite ends every index
    // with rowid, the head order's tiebreak, where pg-boss's ends with id.
    `CREATE INDEX pgboss_job_key_strict_fifo_heads_i
    ON pgboss_job (queue_name, singleton_key, state DESC, created_on)
    WHERE state IN ('created', 'retry') AND policy = 'key_strict_fifo'`,
  ],
  { rows: 'keep' },
);
