import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-http-exception-factory.ts';

test('no-http-exception-factory', () => {
  typescriptRuleTester().run('no-http-exception-factory', rule, {
    valid: [
      {
        code: `app.post('/sources', async (c) => {\n  throw new HTTPException(400, { message: 'Invalid source', cause: { code: 'invalid_source' } });\n});`,
      },
      {
        code: `export const route = domain(parse, (error) => new HTTPException(422, { message: error.message }));`,
      },
      {
        code: `function toHTTPException(error: DomainError) {\n  if (error.kind === 'missing') return new HTTPException(404, { message: error.message });\n  return new HTTPException(500, { message: error.message });\n}`,
      },
      {
        code: `class NotFound extends DomainError {\n  toHTTPException() {\n    return new HTTPException(this.status, { message: this.message });\n  }\n}`,
      },
      {
        code: `function invalid(detail: string) {\n  return new Error(detail);\n}`,
      },
    ],
    invalid: [
      {
        code: `function invalidSource(detail: string): HTTPException {\n  return new HTTPException(400, { message: 'Invalid source', cause: { code: 'invalid_source', detail } });\n}`,
        errors: [{ messageId: 'matched', line: 1 }],
      },
      {
        code: `export const invalidSource = (detail: string) => new HTTPException(400, { cause: { code: 'invalid_source', detail } });`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `const invalidSource = (detail: string) => {\n  return new HTTPException(400, { cause: { code: 'invalid_source', detail } });\n};`,
        errors: [{ messageId: 'matched', line: 1 }],
      },
      {
        code: `const invalidSource = function (detail: string) {\n  return new HTTPException(400, { cause: { code: 'invalid_source', detail } });\n};`,
        errors: [{ messageId: 'matched', line: 1 }],
      },
      {
        code: `async function invalidSource(error: unknown) {\n  return new HTTPException(400, { cause: { code: 'invalid_source', detail: await describe(error) } });\n}`,
        errors: [{ messageId: 'matched', line: 1 }],
      },
      {
        code: `function failed(code: Code) {\n  return new HTTPException(STATUS[code], { cause: { code } });\n}`,
        errors: [{ messageId: 'matched', line: 1 }],
      },
    ],
  });
});
