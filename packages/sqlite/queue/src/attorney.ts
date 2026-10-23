import assert from 'node:assert';

import {
  type Clock,
  type JobAttempt,
  type SendOptions,
  systemClock,
} from 'pg-boss';

import type { TimekeeperConfig } from './timekeeper.ts';

// The supervisor's timers, in seconds (node_modules/pg-boss/dist/attorney.js:
// 608-620).
export type SuperviseIntervals = {
  superviseIntervalSeconds: number;
  maintenanceIntervalSeconds: number;
  monitorIntervalSeconds: number;
  queueCacheIntervalSeconds: number;
};

// pg-boss's argument validation (node_modules/pg-boss/dist/attorney.js,
// 12.35.1). pg-boss ships no exports map, so these are module-private there:
// each assert is ported by citation and proven equal by the parity suite.
// pg-boss compares raw values (`config.x >= 1`); `Number(value) >= n` keeps
// JavaScript's relational coercion for primitives without widening types.
export class Attorney {
  // attorney.js:5
  static readonly MAX_EXPIRATION_HOURS = 24;
  // attorney.js:6
  static readonly MIN_POLLING_INTERVAL_MS = 500;
  // attorney.js:428
  static readonly #clockMethods = [
    'now',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
  ] as const;

  // attorney.js:429-437
  static applyClockConfig(clock: Clock | undefined): Clock {
    if (clock) {
      for (const method of Attorney.#clockMethods) {
        assert(
          typeof clock[method] === 'function',
          `configuration assert: clock must implement ${method}()`,
        );
      }
    }
    return clock || systemClock;
  }

  // attorney.js:608-620, in that order: each at least a second, at most a
  // day, 60 s when unset except maintenance's day. pg-boss writes the
  // defaults onto its config; they are returned here.
  static applyOpsConfig(config: object): SuperviseIntervals {
    const day = Attorney.MAX_EXPIRATION_HOURS * 60 * 60;
    return {
      superviseIntervalSeconds: Attorney.#opsInterval(
        config,
        'superviseIntervalSeconds',
        60,
      ),
      maintenanceIntervalSeconds: Attorney.#opsInterval(
        config,
        'maintenanceIntervalSeconds',
        day,
      ),
      monitorIntervalSeconds: Attorney.#opsInterval(
        config,
        'monitorIntervalSeconds',
        60,
      ),
      queueCacheIntervalSeconds: Attorney.#opsInterval(
        config,
        'queueCacheIntervalSeconds',
        60,
      ),
    };
  }

  static #opsInterval(config: object, key: string, fallback: number): number {
    const value = Attorney.#read(config, key);
    assert(
      !(key in config) || Number(value) >= 1,
      `configuration assert: ${key} must be at least every second`,
    );
    const seconds = Number(value) || fallback;
    assert(
      seconds / 60 / 60 <= Attorney.MAX_EXPIRATION_HOURS,
      `configuration assert: ${key} cannot exceed ${Attorney.MAX_EXPIRATION_HOURS} hours`,
    );
    return seconds;
  }

  // attorney.js:653-660, in that order. clockMonitorIntervalSeconds is
  // validated only: it paces pg-boss's clock-skew read, and SQLite's clock is
  // the database clock.
  static applyScheduleConfig(config: object): TimekeeperConfig {
    Attorney.#scheduleInterval(config, 'clockMonitorIntervalSeconds', {
      max: 600,
      range: 'between 1 second and 10 minutes',
      fallback: 600,
    });
    return {
      cronMonitorIntervalSeconds: Attorney.#scheduleInterval(
        config,
        'cronMonitorIntervalSeconds',
        { max: 45, range: 'between 1 and 45 seconds', fallback: 30 },
      ),
      cronWorkerIntervalSeconds: Attorney.#scheduleInterval(
        config,
        'cronWorkerIntervalSeconds',
        { max: 45, range: 'between 1 and 45 seconds', fallback: 5 },
      ),
    };
  }

  static #scheduleInterval(
    config: object,
    key: string,
    bounds: { max: number; range: string; fallback: number },
  ): number {
    const value = Attorney.#read(config, key);
    assert(
      !(key in config) || (Number(value) >= 1 && Number(value) <= bounds.max),
      `configuration assert: ${key} must be ${bounds.range}`,
    );
    return Number(value) || bounds.fallback;
  }

  // attorney.js:445. warningSlowQuerySeconds and warningRetentionDays (446-449)
  // configure warnings this queue never raises or persists.
  static validateWarningConfig(config: object): void {
    assert(
      !('warningQueueSize' in config) ||
        Number(Attorney.#read(config, 'warningQueueSize')) >= 1,
      'configuration assert: warningQueueSize must be at least 1',
    );
  }

  // attorney.js:585-607: a worker's poll and notify-backstop intervals in ms.
  // pg-boss writes them onto the options object; they are returned here.
  static #applyPollingInterval(config: object): {
    pollingInterval: number;
    notifyPollingInterval: number;
  } {
    const minimum = Attorney.MIN_POLLING_INTERVAL_MS;
    const pollingSeconds = Attorney.#read(config, 'pollingIntervalSeconds');
    assert(
      !('pollingIntervalSeconds' in config) ||
        Number(pollingSeconds) >= minimum / 1000,
      `configuration assert: pollingIntervalSeconds must be at least every ${minimum}ms`,
    );
    const pollingInterval =
      'pollingIntervalSeconds' in config ? Number(pollingSeconds) * 1000 : 2000;
    const notifySeconds = Attorney.#read(
      config,
      'notifyPollingIntervalSeconds',
    );
    assert(
      !('notifyPollingIntervalSeconds' in config) ||
        Number(notifySeconds) >= minimum / 1000,
      `configuration assert: notifyPollingIntervalSeconds must be at least every ${minimum}ms`,
    );
    let notifyPollingInterval = Math.max(30000, pollingInterval);
    if ('notifyPollingIntervalSeconds' in config) {
      notifyPollingInterval = Number(notifySeconds) * 1000;
      assert(
        notifyPollingInterval >= pollingInterval,
        'configuration assert: notifyPollingIntervalSeconds must be at least pollingIntervalSeconds',
      );
    }
    const burstWhenReadyExceeds = Attorney.#read(
      config,
      'burstWhenReadyExceeds',
    );
    assert(
      !('burstWhenReadyExceeds' in config) ||
        (Number.isInteger(burstWhenReadyExceeds) &&
          Number(burstWhenReadyExceeds) >= 1),
      'configuration assert: burstWhenReadyExceeds must be an integer >= 1',
    );
    assert(
      !('burstWhenBatchFull' in config) ||
        typeof config.burstWhenBatchFull === 'boolean',
      'configuration assert: burstWhenBatchFull must be a boolean',
    );
    return { pollingInterval, notifyPollingInterval };
  }

  // attorney.js:357-383. pg-boss checks a copy of the options and writes the
  // poll intervals onto it; they are returned here instead.
  static checkWorkArgs(
    name: unknown,
    args: readonly unknown[],
  ): { pollingInterval: number; notifyPollingInterval: number } {
    assert(name, 'queue name is required');
    let options: unknown;
    let callback: unknown;
    if (args.length === 1) {
      callback = args[0];
      options = {};
    } else if (args.length > 1) {
      options = args[0] || {};
      callback = args[1];
    }
    assert(
      typeof callback === 'function',
      'expected callback to be a function',
    );
    assert(typeof options === 'object', 'expected config to be an object');
    const config: object = { ...options };
    const intervals = Attorney.#applyPollingInterval(config);
    const read = (key: string) => Attorney.#read(config, key);
    assert(
      !('batchSize' in config) ||
        (Number.isInteger(read('batchSize')) && Number(read('batchSize')) >= 1),
      'batchSize must be an integer > 0',
    );
    assert(
      !('includeMetadata' in config) ||
        typeof read('includeMetadata') === 'boolean',
      'includeMetadata must be a boolean',
    );
    assert(
      !('priority' in config) || typeof read('priority') === 'boolean',
      'priority must be a boolean',
    );
    assert(
      !('localConcurrency' in config) ||
        (Number.isInteger(read('localConcurrency')) &&
          Number(read('localConcurrency')) >= 1),
      'localConcurrency must be an integer >= 1',
    );
    assert(
      !('perJobResults' in config) ||
        typeof read('perJobResults') === 'boolean',
      'perJobResults must be a boolean',
    );
    assert(
      !('transactional' in config) ||
        typeof read('transactional') === 'boolean',
      'transactional must be a boolean',
    );
    Attorney.#validatePriorityRangeConfig(config);
    Attorney.#validateGroupConcurrencyConfig(config);
    Attorney.#validateHeartbeatRefreshConfig(config);
    Attorney.#validateTransactionalConfig(config);
    return intervals;
  }

  // pg-boss reads options as plain properties, inherited ones included.
  static #read(config: object, key: string): unknown {
    return key in config ? Reflect.get(config, key) : undefined;
  }

  // attorney.js:320-330
  static #validatePriorityRangeConfig(config: object): void {
    const minPriority = Attorney.#read(config, 'minPriority');
    const maxPriority = Attorney.#read(config, 'maxPriority');
    if (minPriority !== undefined) {
      assert(Number.isInteger(minPriority), 'minPriority must be an integer');
    }
    if (maxPriority !== undefined) {
      assert(Number.isInteger(maxPriority), 'maxPriority must be an integer');
    }
    if (minPriority !== undefined && maxPriority !== undefined) {
      assert(
        Number(minPriority) <= Number(maxPriority),
        'minPriority must be <= maxPriority',
      );
    }
  }

  // attorney.js:331-341
  static #validateGroupConcurrencyConfig(config: object): void {
    const groupConcurrency = Attorney.#read(config, 'groupConcurrency');
    const localGroupConcurrency = Attorney.#read(
      config,
      'localGroupConcurrency',
    );
    const hasGlobal = groupConcurrency != null;
    const hasLocal = localGroupConcurrency != null;
    assert(
      !(hasGlobal && hasLocal),
      'cannot specify both groupConcurrency and localGroupConcurrency - choose one',
    );
    if (hasGlobal) {
      Attorney.#validateGroupConcurrencyValue(
        groupConcurrency,
        'groupConcurrency',
      );
    }
    if (hasLocal) {
      Attorney.#validateGroupConcurrencyValue(
        localGroupConcurrency,
        'localGroupConcurrency',
      );
      Attorney.#validateLocalGroupConcurrencyLimit(
        localGroupConcurrency,
        Attorney.#read(config, 'localConcurrency'),
      );
    }
  }

  // attorney.js:306-319
  static #validateGroupConcurrencyValue(value: unknown, name: string): void {
    if (typeof value === 'number') {
      assert(
        Number.isInteger(value) && value >= 1,
        `${name} must be an integer >= 1`,
      );
      return;
    }
    assert(
      typeof value === 'object' && value !== null,
      `${name} must be a number or an object with { default, tiers? }`,
    );
    const fallback = Attorney.#read(value, 'default');
    assert(
      Number.isInteger(fallback) && Number(fallback) >= 1,
      `${name}.default must be an integer >= 1`,
    );
    const tiers = Attorney.#read(value, 'tiers');
    if (tiers) {
      assert(typeof tiers === 'object', `${name}.tiers must be an object`);
      for (const [tier, limit] of Object.entries(tiers)) {
        assert(
          typeof tier === 'string' && tier.length > 0,
          `${name} tier keys must be non-empty strings`,
        );
        assert(
          Number.isInteger(limit) && Number(limit) >= 1,
          `${name}.tiers["${tier}"] must be an integer >= 1`,
        );
      }
    }
  }

  // attorney.js:342-356
  static #validateLocalGroupConcurrencyLimit(
    localGroupConcurrency: unknown,
    localConcurrency: unknown,
  ): void {
    const effective = localConcurrency ?? 1;
    if (typeof localGroupConcurrency === 'number') {
      assert(
        localGroupConcurrency <= Number(effective),
        `localGroupConcurrency (${localGroupConcurrency}) cannot exceed localConcurrency (${effective})`,
      );
    } else if (
      typeof localGroupConcurrency === 'object' &&
      localGroupConcurrency !== null
    ) {
      const fallback = Attorney.#read(localGroupConcurrency, 'default');
      assert(
        Number(fallback) <= Number(effective),
        `localGroupConcurrency.default (${fallback}) cannot exceed localConcurrency (${effective})`,
      );
      const tiers = Attorney.#read(localGroupConcurrency, 'tiers');
      if (typeof tiers === 'object' && tiers !== null) {
        for (const [tier, limit] of Object.entries(tiers)) {
          assert(
            Number(limit) <= Number(effective),
            `localGroupConcurrency.tiers["${tier}"] (${limit}) cannot exceed localConcurrency (${effective})`,
          );
        }
      }
    }
  }

  // attorney.js:401-405
  static #validateHeartbeatRefreshConfig(config: object): void {
    const refresh = Attorney.#read(config, 'heartbeatRefreshSeconds');
    if (refresh == null) {
      return;
    }
    assert(
      typeof refresh === 'number' && refresh > 0,
      'heartbeatRefreshSeconds must be a number > 0',
    );
  }

  // attorney.js:388-398
  static #validateTransactionalConfig(config: object): void {
    const timeout = Attorney.#read(config, 'transactionTimeoutSeconds');
    assert(
      !('transactionTimeoutSeconds' in config) ||
        (Number.isInteger(timeout) && Number(timeout) >= 0),
      'transactionTimeoutSeconds must be an integer >= 0',
    );
    if (!Attorney.#read(config, 'transactional')) {
      assert(
        !('transactionTimeoutSeconds' in config),
        'transactionTimeoutSeconds requires transactional',
      );
      return;
    }
    assert(
      !Attorney.#read(config, 'perJobResults'),
      'transactional cannot be combined with perJobResults',
    );
  }

  // attorney.js:87-89
  static assertObjectName(value: unknown, name: string): void {
    assert(
      /^[\w.\-/]+$/.test(String(value)),
      `${name} can only contain alphanumeric characters, underscores, hyphens, periods, or forward slashes`,
    );
  }

  // manager.js:1596-1605: ids, or jobs as fetch() and work() hand them out,
  // whose retryCount fences the call to the attempt that was fetched.
  static mapAttemptArg(
    id: string | string[] | JobAttempt | JobAttempt[],
    funcName: string,
  ): { ids: string[]; attempts?: number[] } {
    assert(id, `${funcName}() requires an id`);
    const items = Array.isArray(id) ? id : [id];
    assert(items.length, `${funcName}() requires an id`);
    if (items.every((item) => typeof item === 'string')) {
      return { ids: items };
    }
    const jobs = items.filter(
      (item): item is JobAttempt =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        Number.isInteger(item.retryCount) &&
        item.retryCount >= 0,
    );
    assert(
      jobs.length === items.length,
      `${funcName}() requires either ids or jobs with an id and an integer retryCount, not a mix`,
    );
    return {
      ids: jobs.map((job) => job.id),
      attempts: jobs.map((job) => job.retryCount),
    };
  }

  // attorney.js:554-559
  static assertKey(key: unknown): void {
    if (!key) {
      return;
    }
    assert(typeof key === 'string', 'Key must be a string');
    Attorney.assertObjectName(key, 'Key');
  }

  // attorney.js:549-553
  static assertQueueName(name: unknown): asserts name is string {
    assert(name, 'Name is required');
    assert(typeof name === 'string', 'Name must be a string');
    Attorney.assertObjectName(name, 'Name');
  }

  // attorney.js:90-101
  static validateQueueArgs(config: object): void {
    const deadLetter = 'deadLetter' in config ? config.deadLetter : undefined;
    assert(
      !('deadLetter' in config) ||
        deadLetter === null ||
        typeof deadLetter === 'string',
      'deadLetter must be a string',
    );
    assert(
      !('notify' in config) || typeof config.notify === 'boolean',
      'notify must be a boolean',
    );
    if (deadLetter) {
      Attorney.assertObjectName(deadLetter, 'deadLetter');
    }
    Attorney.#validateRetryConfig(config);
    Attorney.#validateExpirationConfig(config);
    Attorney.#validateRetentionConfig(config);
    Attorney.#validateDeletionConfig(config);
    Attorney.#validateHeartbeatConfig(config);
  }

  // attorney.js:118-153: the positional send(name, data, options) and the
  // request send({ name, data, options }), the options checked and returned
  // as an own-property copy. The startAfter normalization it ends with lives
  // in StartAfter.
  static checkSendArgs(args: readonly unknown[]): {
    name: unknown;
    data: unknown;
    options: SendOptions;
  } {
    let name: unknown;
    let data: unknown;
    let options: unknown;
    const [first] = args;
    if (typeof first === 'string') {
      name = first;
      data = args[1];
      assert(
        typeof data !== 'function',
        'send() cannot accept a function as the payload.  Did you intend to use work()?',
      );
      options = args[2];
    } else if (typeof first === 'object') {
      assert(args.length === 1, 'send object API only accepts 1 argument');
      assert(first, 'boss requires all jobs to have a name');
      name = Attorney.#read(first, 'name');
      data = Attorney.#read(first, 'data');
      options = Attorney.#read(first, 'options');
    }
    const supplied = options || {};
    assert(name, 'boss requires all jobs to have a queue name');
    assert(typeof supplied === 'object', 'options should be an object');
    const copy: SendOptions = { ...supplied };
    assert(
      !('priority' in copy) || Number.isInteger(copy.priority),
      'priority must be an integer',
    );
    Attorney.#validateRetryConfig(copy);
    Attorney.#validateExpirationConfig(copy);
    Attorney.#validateRetentionConfig(copy);
    Attorney.#validateDeletionConfig(copy);
    Attorney.#validateGroupConfig(copy);
    Attorney.#validateHeartbeatConfig(copy);
    return { name, data, options: copy };
  }

  // attorney.js:208-215
  static #validateGroupConfig(config: object): void {
    if (
      !('group' in config) ||
      config.group === undefined ||
      config.group === null
    ) {
      return;
    }
    const group = config.group;
    assert(typeof group === 'object', 'group must be an object');
    assert(
      'id' in group && typeof group.id === 'string' && group.id.length > 0,
      'group.id must be a non-empty string',
    );
    assert(
      !('tier' in group) ||
        (typeof group.tier === 'string' && group.tier.length > 0),
      'group.tier must be a non-empty string if provided',
    );
  }

  // attorney.js:570-576
  static #validateRetryConfig(config: object): void {
    assert(
      !('retryDelay' in config) ||
        (Number.isInteger(config.retryDelay) && Number(config.retryDelay) >= 0),
      'retryDelay must be an integer >= 0',
    );
    assert(
      !('retryLimit' in config) ||
        (Number.isInteger(config.retryLimit) && Number(config.retryLimit) >= 0),
      'retryLimit must be an integer >= 0',
    );
    assert(
      !('retryBackoff' in config) ||
        config.retryBackoff === true ||
        config.retryBackoff === false,
      'retryBackoff must be either true or false',
    );
    const retryBackoff =
      'retryBackoff' in config ? config.retryBackoff : undefined;
    assert(
      !('retryDelayMax' in config) ||
        config.retryDelayMax === null ||
        retryBackoff === true,
      'retryDelayMax can only be set if retryBackoff is true',
    );
    assert(
      !('retryDelayMax' in config) ||
        config.retryDelayMax === null ||
        (Number.isInteger(config.retryDelayMax) &&
          Number(config.retryDelayMax) >= 0),
      'retryDelayMax must be an integer >= 0',
    );
  }

  // attorney.js:563-569
  static #validateExpirationConfig(config: object): void {
    const expireInSeconds =
      'expireInSeconds' in config ? config.expireInSeconds : undefined;
    assert(
      !('expireInSeconds' in config) || Number(expireInSeconds) >= 1,
      'configuration assert: expireInSeconds must be at least every second',
    );
    assert(
      !expireInSeconds ||
        Number(expireInSeconds) / 60 / 60 <= Attorney.MAX_EXPIRATION_HOURS,
      `configuration assert: expiration cannot exceed ${Attorney.MAX_EXPIRATION_HOURS} hours`,
    );
  }

  // attorney.js:560-562
  static #validateRetentionConfig(config: object): void {
    assert(
      !('retentionSeconds' in config) || Number(config.retentionSeconds) >= 1,
      'configuration assert: retentionSeconds must be at least every second',
    );
  }

  // attorney.js:650-652
  static #validateDeletionConfig(config: object): void {
    assert(
      !('deleteAfterSeconds' in config) ||
        Number(config.deleteAfterSeconds) >= 0,
      'configuration assert: deleteAfterSeconds must be at least 0 (0 disables deletion)',
    );
  }

  // attorney.js:577-579
  static #validateHeartbeatConfig(config: object): void {
    assert(
      !('heartbeatSeconds' in config) ||
        config.heartbeatSeconds === null ||
        (Number.isInteger(config.heartbeatSeconds) &&
          Number(config.heartbeatSeconds) >= 10),
      'heartbeatSeconds must be an integer >= 10',
    );
  }
}
