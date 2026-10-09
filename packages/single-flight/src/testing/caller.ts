import { join } from 'node:path';

const indexUrl = new URL('../index.ts', import.meta.url);

/**
 * The codec of a caller process:
 * - `json`: plain JSON.
 * - `dates`: JSON that turns ISO date strings back into dates.
 * - `encode-throws` and `decode-throws`: JSON whose one direction fails.
 */
export type CallerCodec = 'json' | 'dates' | 'encode-throws' | 'decode-throws';

export interface CallerOptions {
  codec?: CallerCodec;
  graceWindow?: number;
}

/** Where each caller process appends `<name>:work:<key>` when its work runs, so a test counts the runs of the work. */
export function journalOf(directory: string) {
  return join(directory, 'journal.log');
}

/**
 * The source of a process that uses one `SingleFlight` on `directory`, for
 * `startWorker`. A test drives it with orders over IPC, and it reports what
 * the public API gave it:
 * - `{ type: 'run', call, key }` calls `run`. The work reports `leading` with
 *   its token, and waits for an order for that call: `finish` with a `value`,
 *   `fail` with a `message` and a `code`, or `throw` with a value that is not
 *   an error. A lost lease reports `lost`. `onJoin` reports `joined`.
 * - `{ type: 'cancel', call }` aborts that call's signal.
 * - `{ type: 'dispose' }` disposes the single flight and reports `disposed`.
 * Each call ends with `value` (with `joined`, the value's keys, and which of
 * them hold a Date) or `error` (with the error's class name, message, and
 * `failure`).
 */
export function callerSource(
  directory: string,
  { codec = 'json', graceWindow = 500 }: CallerOptions = {},
) {
  return `
    import { appendFileSync } from 'node:fs';
    import { SingleFlight } from ${JSON.stringify(indexUrl.href)};

    const name = process.argv[1];
    const isoDate = /^\\d{4}-\\d{2}-\\d{2}T/;
    const codecs = {
      json: { encode: JSON.stringify, decode: JSON.parse },
      dates: {
        encode: JSON.stringify,
        decode: (text) =>
          JSON.parse(text, (_, v) => (typeof v === 'string' && isoDate.test(v) ? new Date(v) : v)),
      },
      'encode-throws': {
        encode: () => { throw new TypeError('This value cannot be encoded'); },
        decode: JSON.parse,
      },
      'decode-throws': {
        encode: JSON.stringify,
        decode: () => { throw new SyntaxError('This text cannot be decoded'); },
      },
    };
    const flights = new SingleFlight({
      directory: ${JSON.stringify(directory)},
      codec: codecs[${JSON.stringify(codec)}],
      graceWindow: ${graceWindow},
    });
    const finishes = new Map();
    const cancels = new Map();

    process.on('message', (order) => {
      if (order.type === 'run') void call(order);
      if (['finish', 'fail', 'throw'].includes(order.type)) finishes.get(order.call)?.(order);
      if (order.type === 'cancel') cancels.get(order.call)?.abort(new Error('cancelled by ' + name));
      if (order.type === 'dispose') {
        void flights[Symbol.asyncDispose]().then(() => process.send({ type: 'disposed' }));
      }
    });

    const shape = (value) =>
      typeof value === 'object' && value !== null
        ? {
            keys: Object.keys(value),
            dates: Object.keys(value).filter((key) => value[key] instanceof Date),
          }
        : { keys: [], dates: [] };

    async function call({ call, key }) {
      const cancel = new AbortController();
      cancels.set(call, cancel);
      try {
        // run hands the request to the connection before its first await, so 'called' means it went out.
        const running = flights.run(
          key,
          async ({ token, signal }) => {
            appendFileSync(${JSON.stringify(journalOf(directory))}, name + ':work:' + key + '\\n');
            signal.addEventListener('abort', () =>
              process.send({ type: 'lost', call, reason: signal.reason?.name }),
            );
            const order = await new Promise((resolve) => {
              finishes.set(call, resolve);
              process.send({ type: 'leading', call, token: String(token.value) });
            });
            if (order.type === 'fail') {
              throw Object.assign(new Error(order.message), { code: order.code });
            }
            if (order.type === 'throw') throw order.thrown;
            return order.value;
          },
          { signal: cancel.signal, onJoin: () => process.send({ type: 'joined', call }) },
        );
        process.send({ type: 'called', call });
        const { value, joined } = await running;
        process.send({ type: 'value', call, value, joined, ...shape(value) });
      } catch (error) {
        process.send({
          type: 'error',
          call,
          name: error?.constructor?.name,
          message: error?.message,
          failure: error?.failure,
        });
      }
    }

    process.send({ type: 'ready' });
  `;
}
