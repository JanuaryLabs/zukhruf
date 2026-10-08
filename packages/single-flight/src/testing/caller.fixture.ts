// One caller of SharedFlight in its own process: started by startCaller() with
// a records directory and a lock directory. It runs the key `sync` once and
// reports over IPC. When it leads, its work waits for an order from the test.
import { Mutex, SqliteStore } from '@zukhruf/mutex';

import { FileFlightRecords, SharedFlight } from '../index.ts';
import { type Message, type Order, isOrder } from './caller-process.ts';

const [records, locks] = process.argv.slice(2);
if (records === undefined || locks === undefined)
  throw new Error(
    'Usage: caller.fixture.ts <records directory> <lock directory>',
  );

const say = (message: Message) => process.send?.(message);
const ordered = Promise.withResolvers<Order>();
process.on('message', (message) => {
  if (isOrder(message)) ordered.resolve(message);
});

const flights = new SharedFlight({
  mutex: new Mutex(new SqliteStore(locks)),
  records: new FileFlightRecords(records),
  parse: (value) => {
    if (typeof value !== 'string') throw new TypeError('A report is text.');
    return value;
  },
  pollInterval: 10,
});

try {
  const { value, joined } = await flights.run(
    'sync',
    async () => {
      say({ type: 'flying' });
      const order = await ordered.promise;
      if (order.type === 'land') return order.value;
      throw Object.assign(new Error(order.message), {
        name: order.name,
        code: order.code,
      });
    },
    { onJoin: () => say({ type: 'joined' }) },
  );
  say({ type: 'landed', value, joined });
} catch (error) {
  say({
    type: 'failed',
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
}
