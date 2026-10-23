import type { SendOptions } from 'pg-boss';

import { DatabaseError } from './database-error.ts';
import { NaiveTimestamp } from './naive-timestamp.ts';

// pg-boss's send throttle: singletonSeconds, and singletonNextSlot to retry a
// refused send into the next slot.
export class Throttle {
  // pg-boss's throttle slot: singletonSeconds wide, shifted by an offset, as a
  // zoneless timestamp (node_modules/pg-boss/dist/plans.js:2279). A null width
  // is no throttle there (`"singletonSeconds" IS NOT NULL`), and a zero width
  // divides by zero in Postgres, which pg-boss surfaces as the driver's error.
  // The offset is 0, or singletonSeconds when a refused send retries into the
  // next slot (manager.js:1253-1256).
  static slot(
    singletonSeconds: SendOptions['singletonSeconds'],
    offset: SendOptions['singletonSeconds'],
    now: Date,
  ): string | null {
    if (singletonSeconds === undefined || singletonSeconds === null) {
      return null;
    }
    const width = Number(singletonSeconds);
    if (width === 0) {
      throw new DatabaseError('division by zero', '22012');
    }
    const slotStartSeconds =
      width * Math.floor((now.getTime() / 1000 + Number(offset)) / width);
    return NaiveTimestamp.fromUtc(new Date(slotStartSeconds * 1000));
  }

  // manager.js:1533-1542: seconds until the next throttle slot starts, never 0,
  // and one more for slots wider than a second. Without a width the slot
  // arithmetic is NaN, which the `|| 1` floors, as in pg-boss.
  static debounceStartAfter(
    singletonSeconds: SendOptions['singletonSeconds'],
    now: Date,
  ): number {
    const width = Number(singletonSeconds);
    const interval = width * 1000;
    const slotStart = Math.floor(now.getTime() / interval) * interval;
    const elapsedSeconds = Math.floor((now.getTime() - slotStart) / 1000);
    const startAfter = width - elapsedSeconds || 1;
    return width > 1 ? startAfter + 1 : startAfter;
  }
}
