import type { GroupConcurrencyConfig } from 'pg-boss';

import type { JobRow } from './job-rows.ts';

// pg-boss's localGroupConcurrency (node_modules/pg-boss/dist/manager.js:
// 226-282, 454-501): this process's running jobs per group of each queue,
// counted in memory and never shared with another process.
export class LocalGroups {
  readonly #configs = new Map<string, GroupConcurrencyConfig>();
  readonly #active = new Map<string, Map<string, number>>();
  readonly #maxLimits = new Map<string, number>();

  // manager.js:454-462
  configure(
    name: string,
    localGroupConcurrency: number | GroupConcurrencyConfig,
  ): void {
    const config =
      typeof localGroupConcurrency === 'number'
        ? { default: localGroupConcurrency }
        : localGroupConcurrency;
    this.#configs.set(name, config);
    this.#maxLimits.set(
      name,
      config.tiers
        ? Math.max(config.default, ...Object.values(config.tiers))
        : config.default,
    );
  }

  // The groups with no room left for any tier, which a fetch skips
  // (manager.js:235-256).
  atCapacity(name: string): string[] {
    const config = this.#configs.get(name);
    const counts = this.#active.get(name);
    if (!config || !counts) {
      return [];
    }
    const maxLimit = this.#maxLimits.get(name) ?? config.default;
    return Array.from(counts)
      .filter(([, count]) => count >= maxLimit)
      .map(([groupId]) => groupId);
  }

  // Counts each job that fits its group's limit, in batch order; a job
  // without a group always fits and is not counted (manager.js:472-494).
  start(name: string, jobs: JobRow[]) {
    const allowed: JobRow[] = [];
    const excess: JobRow[] = [];
    const grouped: JobRow[] = [];
    for (const job of jobs) {
      if (!job.group_id) {
        allowed.push(job);
        continue;
      }
      const count = this.#active.get(name)?.get(job.group_id) || 0;
      if (count < this.#limit(name, job.group_tier)) {
        this.#increment(name, job.group_id);
        allowed.push(job);
        grouped.push(job);
      } else {
        excess.push(job);
      }
    }
    return { allowed, excess, grouped };
  }

  // manager.js:495-501
  end(name: string, grouped: JobRow[]): void {
    for (const job of grouped) {
      if (job.group_id) {
        this.#decrement(name, job.group_id);
      }
    }
  }

  // manager.js:463-471, once no live worker is left on the queue.
  forget(name: string): void {
    this.#configs.delete(name);
    this.#active.delete(name);
    this.#maxLimits.delete(name);
  }

  // manager.js:876-879
  clear(): void {
    this.#configs.clear();
    this.#active.clear();
    this.#maxLimits.clear();
  }

  // `in`, as pg-boss looks a tier up, so an inherited property such as
  // `constructor` is found and no count is below it (manager.js:226-234).
  #limit(name: string, groupTier: string | null): number {
    const config = this.#configs.get(name);
    if (!config) {
      return Infinity;
    }
    if (groupTier && config.tiers && groupTier in config.tiers) {
      const limit = config.tiers[groupTier];
      // Never undefined: an own tier is an integer (Attorney's
      // groupConcurrency check) and an inherited one is a function.
      if (limit !== undefined) {
        return limit;
      }
    }
    return config.default;
  }

  #increment(name: string, groupId: string): void {
    let counts = this.#active.get(name);
    if (!counts) {
      counts = new Map();
      this.#active.set(name, counts);
    }
    counts.set(groupId, (counts.get(groupId) || 0) + 1);
  }

  #decrement(name: string, groupId: string): void {
    const counts = this.#active.get(name);
    if (!counts) {
      return;
    }
    const count = counts.get(groupId) || 0;
    if (count <= 1) {
      counts.delete(groupId);
    } else {
      counts.set(groupId, count - 1);
    }
  }
}
