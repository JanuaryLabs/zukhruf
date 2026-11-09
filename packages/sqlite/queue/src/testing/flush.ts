import type { TestClock } from 'pg-boss';

// Lets everything due now finish on both backends: tick(0) waits until each
// one's statements in flight have settled, SQLite's through its attached
// Activity (node_modules/pg-boss/dist/clock.js:88-117, activity.js:77-93).
export async function flush(clock: TestClock) {
  await clock.tick(0);
}
