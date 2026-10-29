import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-catch-around-next.ts';

const hono = `import { createMiddleware } from 'hono/factory';\n`;

test('no-catch-around-next', () => {
  typescriptRuleTester().run('no-catch-around-next', rule, {
    valid: [
      {
        code: `${hono}export const audit = createMiddleware(async (c, next) => {\n  try {\n    await next();\n    log(c);\n  } catch (error) {\n    report(error);\n  }\n});`,
      },
      {
        code: `${hono}export const audit = createMiddleware(async (c, next) => {\n  try {\n    log(c);\n    await next();\n  } catch (error) {\n    report(error);\n  }\n});`,
      },
      {
        code: `import Koa from 'koa';\nconst app = new Koa();\napp.use(async (ctx, next) => {\n  try {\n    await next();\n  } catch (error) {\n    ctx.status = 500;\n  }\n});`,
      },
      {
        code: `${hono}export const timing = createMiddleware(async (c, next) => {\n  try {\n    await next();\n  } finally {\n    record(c);\n  }\n});`,
      },
      {
        code: `${hono}export const audit = createMiddleware(async (c, next) => {\n  await next();\n  if (c.error) report(c.error);\n});`,
      },
      {
        code: `import { createMiddleware } from 'hono-foo';\nexport const audit = createMiddleware(async (c, next) => {\n  try {\n    await next();\n  } catch {}\n});`,
      },
    ],
    invalid: [
      {
        code: `${hono}export const translate = createMiddleware(async (c, next) => {\n  try {\n    await next();\n  } catch (error) {\n    throw new HTTPException(500, { cause: error });\n  }\n});`,
        errors: [{ messageId: 'deadCatch' }],
      },
      {
        code: `import type { MiddlewareHandler } from 'hono';\nexport const translate: MiddlewareHandler = async (c, next) => {\n  try {\n    return await next();\n  } catch (error) {\n    return c.json({ error: String(error) }, 500);\n  }\n};`,
        errors: [{ messageId: 'deadCatch' }],
      },
      {
        code: `${hono}export const translate = createMiddleware((c, next) => {\n  try {\n    return next();\n  } catch (error) {\n    return c.json({ error: String(error) }, 500);\n  }\n});`,
        errors: [{ messageId: 'deadCatch' }],
      },
    ],
  });
});
