import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';
import {
  isBooleanLiteralType,
  isIntrinsicBooleanType,
  isIntrinsicUndefinedType,
  unionConstituents,
} from 'ts-api-utils';
import type ts from 'typescript';

import { eslintRule } from '../authoring/rule-module.ts';

/** Whether `type` is a flag, or can be `undefined` until something sets it. */
function holdsFlag(type: ts.Type): boolean {
  return unionConstituents(type).some(
    (part) =>
      isBooleanLiteralType(part) ||
      isIntrinsicBooleanType(part) ||
      isIntrinsicUndefinedType(part),
  );
}

/** A private field and a public field of the same name are different fields. */
function keyOf(name: TSESTree.Node): string | undefined {
  if (name.type === 'PrivateIdentifier') return `#${name.name}`;
  if (name.type === 'Identifier') return name.name;
  return undefined;
}

/**
 * Whether an assignment runs while the constructor runs. A callback that the
 * constructor creates runs later, for example on an event, so its assignment
 * changes the field after construction.
 */
function inConstructor(ancestors: TSESTree.Node[]): boolean {
  for (const node of ancestors.toReversed()) {
    if (node.type === 'ArrowFunctionExpression') return false;
    if (
      node.type === 'FunctionExpression' ||
      node.type === 'FunctionDeclaration'
    ) {
      return (
        node.parent.type === 'MethodDefinition' &&
        node.parent.kind === 'constructor'
      );
    }
    if (
      node.type === 'PropertyDefinition' ||
      node.type === 'StaticBlock' ||
      node.type === 'ClassBody'
    ) {
      return false;
    }
  }
  return false;
}

interface Field {
  node: TSESTree.PropertyDefinition | TSESTree.TSParameterProperty;
  name: TSESTree.Node;
  optional: boolean;
}

/** Whether `statement` is `this.#name ??= …;` on its own. */
function memoStatement(statement: TSESTree.Node, name: string): boolean {
  if (statement.type !== 'ExpressionStatement') return false;
  const { expression } = statement;
  return (
    expression.type === 'AssignmentExpression' &&
    expression.operator === '??=' &&
    expression.left.type === 'MemberExpression' &&
    expression.left.object.type === 'ThisExpression' &&
    expression.left.property.type === 'PrivateIdentifier' &&
    expression.left.property.name === name
  );
}

/**
 * Whether a read of `this.#name` comes after a top-level `this.#name ??= …;`
 * statement of its own function body. That statement always runs first, so the
 * read never sees the field before it is set.
 */
function readsAfterMemo(
  read: TSESTree.MemberExpression,
  name: string,
): boolean {
  let node: TSESTree.Node | undefined = read.parent;
  while (
    node &&
    node.type !== 'FunctionExpression' &&
    node.type !== 'ArrowFunctionExpression' &&
    node.type !== 'FunctionDeclaration'
  ) {
    node = node.parent;
  }
  if (node?.body?.type !== 'BlockStatement') return false;
  return node.body.body.some(
    (statement) =>
      statement.range[1] <= read.range[0] && memoStatement(statement, name),
  );
}

/** Whether `member` is the target of a destructuring or loop assignment. */
function patternTarget(member: TSESTree.MemberExpression): boolean {
  const { parent } = member;
  switch (parent.type) {
    case 'ArrayPattern':
    case 'RestElement':
      return true;
    case 'AssignmentPattern':
      return parent.right !== member;
    case 'Property':
      return parent.parent.type === 'ObjectPattern' && parent.value === member;
    case 'ForInStatement':
    case 'ForOfStatement':
      return parent.left === member;
    default:
      return false;
  }
}

/**
 * Whether the occurrences of a private field make it a lazy memo: every write
 * is `this.#name ??= …`, so the field never goes back to nullish, and every
 * read is the value of a `??=` or comes after a top-level `this.#name ??= …;`
 * of its own function body. A field that nothing reads is a flag, not a memo.
 */
function lazyMemo(occurrences: TSESTree.PrivateIdentifier[]): boolean {
  let read = false;
  for (const occurrence of occurrences) {
    const member = occurrence.parent;
    if (
      member.type !== 'MemberExpression' ||
      member.property !== occurrence ||
      member.object.type !== 'ThisExpression'
    ) {
      return false;
    }
    const { parent } = member;
    if (parent.type === 'AssignmentExpression' && parent.left === member) {
      if (parent.operator !== '??=') return false;
      if (parent.parent.type !== 'ExpressionStatement') read = true;
      continue;
    }
    if (parent.type === 'UpdateExpression' || patternTarget(member)) {
      return false;
    }
    if (!readsAfterMemo(member, occurrence.name)) return false;
    read = true;
  }
  return read;
}

const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow boolean or optional class fields that change after the constructor, which store a phase',
    },
    schema: [],
    messages: {
      phaseFlag:
        'Do not keep a phase in a flag or optional field that changes after the constructor: every reader must know which phase holds. Model the phases as State objects, wait on a one-shot latch, push the fact as an event, or ask the platform for it.',
    },
  },
  defaultOptions: [],
  create(context) {
    // Throws the standard "requires type information" error without typed lint.
    const services = ESLintUtils.getParserServices(context);
    const classes: {
      fields: Map<string, Field>;
      changed: Set<string>;
      declared: Set<string>;
      occurrences: Map<string, TSESTree.PrivateIdentifier[]>;
    }[] = [];
    const current = () => classes.at(-1);

    const record = (field: Field) => {
      const key = keyOf(field.name);
      if (key) current()?.fields.set(key, field);
    };

    return {
      ClassBody(node: TSESTree.ClassBody) {
        const declared = new Set<string>();
        for (const member of node.body) {
          if ('key' in member && member.key.type === 'PrivateIdentifier') {
            declared.add(member.key.name);
          }
        }
        classes.push({
          fields: new Map(),
          changed: new Set(),
          declared,
          occurrences: new Map(),
        });
      },
      PrivateIdentifier(node: TSESTree.PrivateIdentifier) {
        if ('key' in node.parent && node.parent.key === node) return;
        const body = current();
        if (!body) return;
        const list = body.occurrences.get(node.name) ?? [];
        list.push(node);
        body.occurrences.set(node.name, list);
      },
      'ClassBody > PropertyDefinition'(node: TSESTree.PropertyDefinition) {
        if (node.static || node.readonly || node.computed) return;
        record({ node, name: node.key, optional: node.optional });
      },
      TSParameterProperty(node: TSESTree.TSParameterProperty) {
        if (node.readonly || node.static) return;
        const name =
          node.parameter.type === 'AssignmentPattern'
            ? node.parameter.left
            : node.parameter;
        const optional = 'optional' in name && name.optional === true;
        record({ node, name, optional });
      },
      AssignmentExpression(node: TSESTree.AssignmentExpression) {
        const target = node.left;
        if (
          target.type !== 'MemberExpression' ||
          target.computed ||
          target.object.type !== 'ThisExpression'
        ) {
          return;
        }
        if (inConstructor(context.sourceCode.getAncestors(node))) return;
        const key = keyOf(target.property);
        if (key) current()?.changed.add(key);
      },
      'ClassBody:exit'() {
        const body = classes.pop();
        if (!body) return;
        // A name the class does not declare belongs to an enclosing class.
        const outer = current();
        for (const [name, list] of body.occurrences) {
          if (body.declared.has(name) || !outer) continue;
          outer.occurrences.set(name, [
            ...(outer.occurrences.get(name) ?? []),
            ...list,
          ]);
        }
        for (const [key, field] of body.fields) {
          if (!body.changed.has(key)) continue;
          if (
            field.name.type === 'PrivateIdentifier' &&
            lazyMemo(body.occurrences.get(field.name.name) ?? [])
          ) {
            continue;
          }
          if (
            field.optional ||
            holdsFlag(services.getTypeAtLocation(field.name))
          ) {
            context.report({ node: field.node, messageId: 'phaseFlag' });
          }
        }
      },
    };
  },
});

export default eslintRule(rule);
