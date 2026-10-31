import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-collect-loop.ts';

test('no-collect-loop reports a for await loop that only pushes each value', () => {
  typescriptRuleTester().run('no-collect-loop', rule, {
    valid: [
      { code: `const out = await Array.fromAsync(stream);` },
      { code: `for await (const x of stream) if (x.ok) out.push(x);` },
      { code: `for await (const x of stream) seen.add(x);` },
      {
        code: `for await (const x of stream) { out.push(x); log(x); }`,
      },
      { code: `for await (const x of stream) { total += x.size; }` },
      // A push that does not use the loop value is not a collection of it.
      { code: `for await (const _ of ticks) out.push(Date.now());` },
      { code: `for await (const data of ticks) out.push(event.data);` },
      { code: `for await (const x of stream) out.push(x, x);` },
      { code: `for await (const x of stream) out.push(...x);` },
      // One stream split into two arrays: Array.fromAsync makes one array.
      {
        code: `for await (const { stream, data } of process) (stream === 'stdout' ? stdout : stderr).push(data);`,
      },
      { code: `for await (const x of stream) buckets[x.kind].push(x);` },
      // A plain for...of over an array is not an async iterable.
      { code: `for (const x of list) out.push(x);` },
    ],
    invalid: [
      {
        code: `for await (const x of stream) out.push(x);`,
        errors: [{ messageId: 'plain' }],
      },
      {
        code: `for await (const chunk of response) { chunks.push(chunk); }`,
        errors: [{ messageId: 'plain' }],
      },
      {
        code: `for await (const line of lines) this.lines.push(line);`,
        errors: [{ messageId: 'plain' }],
      },
      {
        code: `for await (const x of stream) out.push(f(x));`,
        errors: [{ messageId: 'mapped' }],
      },
      {
        code: `for await (const event of events) { out.push(JSON.parse(event.data)); }`,
        errors: [{ messageId: 'mapped' }],
      },
      {
        code: `for await (let x of stream) out.push({ x });`,
        errors: [{ messageId: 'mapped' }],
      },
      {
        code: `for await (const { stream, data } of logs) { chunks.push({ stream, text: decode(data) }); }`,
        errors: [{ messageId: 'mapped' }],
      },
      {
        code: `for await (const { id } of stream) out.push(id);`,
        errors: [{ messageId: 'mapped' }],
      },
      {
        code: `for await (const chunk of response) chunks.push(Buffer.from(chunk));`,
        errors: [{ messageId: 'mapped' }],
      },
    ],
  });
});

test('no-collect-loop leaves a loop that fills an outer array inside a detached async function', () => {
  typescriptRuleTester().run('no-collect-loop', rule, {
    valid: [
      // Other code reads `chunks` while the loop runs; Array.fromAsync would
      // give the array only when the stream ends.
      {
        code: `
          const chunks = [];
          const reading = (async () => {
            for await (const chunk of pending.stream) chunks.push(chunk);
          })();
          await waitFor(() => chunks.length > 0);
          await reading;
        `,
      },
      {
        code: `
          async function collect(source) {
            const events = [];
            const subscription = await source.subscribe();
            const done = (async () => {
              try {
                for await (const event of subscription) {
                  events.push(event);
                }
              } catch (error) {
                if (error.name !== 'AbortError') throw error;
              }
            })();
            return { hints: events, done };
          }
        `,
      },
      // Read before the statement that awaits the stored promise.
      {
        code: `
          const received = [];
          const consume = (async () => {
            for await (const chunk of stream) received.push(chunk);
          })();
          log(received.length);
          await consume;
        `,
      },
      // A function can read the array while the loop runs, wherever it sits.
      {
        code: `
          const received = [];
          const consume = (async () => {
            for await (const chunk of stream) received.push(chunk);
          })();
          await poll(check);
          await consume;
          function check() {
            return received.length > 0;
          }
        `,
      },
      // The awaited call does not take the stored promise.
      {
        code: `
          const received = [];
          const consume = (async () => {
            for await (const chunk of stream) received.push(chunk);
          })();
          await other;
          use(received);
          await consume;
        `,
      },
      // The array outlives one run of the block: a skipped await leaves an
      // earlier loop pushing while a later run reads.
      {
        code: `
          const received = [];
          for (const stream of streams) {
            const consume = (async () => {
              for await (const chunk of stream) received.push(chunk);
            })();
            if (stream.skip) continue;
            await consume;
            use(received);
          }
        `,
      },
      // A var is one binding for every run of the loop body.
      {
        code: `
          for (const stream of streams) {
            var received = [];
            const consume = (async () => {
              for await (const chunk of stream) received.push(chunk);
            })();
            if (stream.skip) continue;
            await consume;
            use(received);
          }
        `,
      },
    ],
    invalid: [
      {
        code: `
          const chunks = [];
          for await (const chunk of pending.stream) chunks.push(chunk);
        `,
        errors: [{ messageId: 'plain' }],
      },
      // Awaited in place: nothing reads `chunks` before the loop ends.
      {
        code: `
          const chunks = [];
          await (async () => {
            for await (const chunk of pending.stream) chunks.push(chunk);
          })();
        `,
        errors: [{ messageId: 'plain' }],
      },
      // Handed to a helper that awaits it before the array is read.
      {
        code: `
          const received = [];
          await settleWithin(
            (async () => {
              for await (const chunk of manager.watch(id)) {
                received.push(chunk);
              }
            })(),
            'drain',
          );
        `,
        errors: [{ messageId: 'plain' }],
      },
      // Stored, but `received` is read only after the promise settles.
      {
        code: `
          it('watches', async () => {
            const received = [];
            const consume = (async () => {
              for await (const chunk of manager.watch(id)) {
                received.push(chunk);
              }
            })();
            await store.appendChunks([chunk]);
            await settleWithin(consume, 'polling stream watch');
            assert.deepStrictEqual(received, [chunk]);
          });
        `,
        errors: [{ messageId: 'plain' }],
      },
      {
        code: `
          const received = [];
          const consume = (async () => {
            for await (const chunk of stream) received.push(chunk);
          })();
          await consume;
          use(received);
        `,
        errors: [{ messageId: 'plain' }],
      },
      {
        code: `
          const received = [];
          const consume = (async () => {
            for await (const chunk of stream) received.push(chunk);
          })();
          const outcome = await settle(consume);
          use(received, outcome);
        `,
        errors: [{ messageId: 'plain' }],
      },
      // The array lives inside the detached function: no other code sees it.
      {
        code: `
          const reading = (async () => {
            const chunks = [];
            for await (const chunk of pending.stream) chunks.push(chunk);
            return chunks;
          })();
        `,
        errors: [{ messageId: 'plain' }],
      },
    ],
  });
});

test('no-collect-loop leaves a loop whose rejection is handled before its outer array is read', () => {
  typescriptRuleTester().run('no-collect-loop', rule, {
    valid: [
      // Array.fromAsync drops the values it got before the stream failed, and
      // the code reads them after it handles the failure.
      {
        code: `
          const passes: string[] = [];
          const error = await (async () => {
            for await (const { connection, outcomes } of pipeline.watch({ signal })) passes.push(
              \`\${connection.name}:\${outcomes.map(({ copy }) => copy.from.name).join(',')}\`,
            );
          })().then(
            () => assert.fail('the lost watcher must be reported'),
            (error: unknown) => error,
          );
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(passes.toSorted(), ['lost:left']);
        `,
      },
      {
        code: `
          const before: string[][] = [];
          const failure = await (async () => {
            for await (const batch of source.watch({ streams, signal }))
              before.push(batch.map((stream) => stream.name));
          })().then(
            () => null,
            (error: unknown) => error,
          );
          use(before, failure);
        `,
      },
      {
        code: `
          const received = [];
          await (async () => {
            for await (const chunk of stream) received.push(chunk);
          })().catch(() => {});
          use(received);
        `,
      },
      {
        code: `
          const received = [];
          try {
            await (async () => {
              for await (const chunk of stream) received.push(chunk);
            })();
          } catch (error) {
            log(error);
          }
          use(received);
        `,
      },
      {
        code: `
          const received = [];
          try {
            for await (const chunk of stream) received.push(chunk);
          } catch {}
          use(received);
        `,
      },
      // A throw that runs only on one branch leaves the other branch handled.
      {
        code: `
          const received = [];
          try {
            for await (const chunk of stream) received.push(chunk);
          } catch (error) {
            if (!aborted(error)) throw error;
          }
          use(received);
        `,
      },
      {
        code: `
          const received = [];
          await assert.rejects(async () => {
            for await (const chunk of stream) received.push(chunk);
          });
          assert.deepEqual(received, [1, 2]);
        `,
      },
      {
        code: `
          const received = [];
          await t.assert.rejects(
            (async () => {
              for await (const chunk of stream) received.push(chunk);
            })(),
            /lost/,
          );
          use(received);
        `,
      },
    ],
    invalid: [
      // A fulfilment handler alone lets the rejection through.
      {
        code: `
          const received = [];
          await (async () => {
            for await (const chunk of stream) received.push(chunk);
          })().then(() => done());
          use(received);
        `,
        errors: [{ messageId: 'plain' }],
      },
      // The array lives inside the function: nothing reads it after a failure.
      {
        code: `
          await (async () => {
            const received = [];
            for await (const chunk of stream) received.push(chunk);
            use(received);
          })().catch(log);
        `,
        errors: [{ messageId: 'plain' }],
      },
      {
        code: `
          try {
            const received = [];
            for await (const chunk of stream) received.push(chunk);
            use(received);
          } catch {}
        `,
        errors: [{ messageId: 'plain' }],
      },
      // A finally block does not handle the rejection.
      {
        code: `
          const received = [];
          try {
            for await (const chunk of stream) received.push(chunk);
          } finally {
            close();
          }
          use(received);
        `,
        errors: [{ messageId: 'plain' }],
      },
      // The catch handles only a failure of its own try block.
      {
        code: `
          const received = [];
          try {
            prepare();
          } catch {}
          for await (const chunk of stream) received.push(chunk);
        `,
        errors: [{ messageId: 'plain' }],
      },
      // A catch that always throws: code after the try runs only on success.
      {
        code: `
          const received = [];
          try {
            for await (const chunk of stream) received.push(chunk);
          } catch (error) {
            log(error);
            throw error;
          }
          use(received);
        `,
        errors: [{ messageId: 'plain' }],
      },
      {
        code: `
          const received = [];
          await (async () => {
            for await (const chunk of stream) received.push(chunk);
          })().catch((error) => {
            throw new Wrapped(error);
          });
          use(received);
        `,
        errors: [{ messageId: 'plain' }],
      },
      {
        code: `
          const received = [];
          await (async () => {
            for await (const chunk of stream) received.push(chunk);
          })().then(done, (error) => Promise.reject(error));
          use(received);
        `,
        errors: [{ messageId: 'plain' }],
      },
      // A loop in the catch block is not guarded by that catch.
      {
        code: `
          const received = [];
          try {
            prepare();
          } catch {
            for await (const chunk of stream) received.push(chunk);
          }
          use(received);
        `,
        errors: [{ messageId: 'plain' }],
      },
      // A helper other than rejects says nothing about the rejection.
      {
        code: `
          const received = [];
          await settle(async () => {
            for await (const chunk of stream) received.push(chunk);
          });
          use(received);
        `,
        errors: [{ messageId: 'plain' }],
      },
    ],
  });
});
