import { selectorRule } from '../authoring/selector-rule.ts';

const PROCESS_ENV = '[object.name="process"][property.name="env"]';

/**
 * Tests run concurrently, and `process.env` is one object for the whole
 * process: a test that sets a variable changes it for every test that runs at
 * the same time, and a restore in `finally` cannot undo what the others read
 * meanwhile. Reads and copies (`{ ...process.env, X: '1' }` for a child
 * process) stay allowed.
 */
export default selectorRule({
  description: 'Disallow a test that changes process.env',
  selectors: [
    `AssignmentExpression[left.object.object.name="process"][left.object.property.name="env"]`,
    `AssignmentExpression > MemberExpression.left${PROCESS_ENV}`,
    `UnaryExpression[operator="delete"][argument.object.object.name="process"][argument.object.property.name="env"]`,
    `CallExpression[callee.object.name="Object"][callee.property.name=/^(assign|defineProperty|defineProperties)$/] > MemberExpression.arguments:first-child${PROCESS_ENV}`,
    'CallExpression[callee.object.name="vi"][callee.property.name="stubEnv"]',
  ],
  message:
    'Tests run concurrently, and process.env is one object for the whole process. Pass the environment (or the value) to the code under test, or give a child process its own env.',
});
