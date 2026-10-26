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
