import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from '@typescript-eslint/utils';
import {
  isBooleanLiteralType,
  isIntrinsicBooleanType,
  isIntrinsicNullType,
  isIntrinsicUndefinedType,
  unionConstituents,
} from 'ts-api-utils';
import type ts from 'typescript';

import { eslintRule } from '../authoring/rule-module.ts';

/** Whether `type` is a flag, or can be `undefined` or `null` until something sets it. */
function holdsFlag(type: ts.Type): boolean {
  return unionConstituents(type).some(
    (part) =>
      isBooleanLiteralType(part) ||
      isIntrinsicBooleanType(part) ||
      isIntrinsicUndefinedType(part) ||
      isIntrinsicNullType(part),
  );
}

type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression;

function isFunction(node: TSESTree.Node): node is FunctionNode {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression'
  );
}

/** Nodes that hold a function as a value without calling it. */
const holdsValue = new Set<AST_NODE_TYPES>([
  AST_NODE_TYPES.ArrayExpression,
  AST_NODE_TYPES.ClassBody,
  AST_NODE_TYPES.ClassExpression,
  AST_NODE_TYPES.MethodDefinition,
  AST_NODE_TYPES.ObjectExpression,
  AST_NODE_TYPES.Property,
  AST_NODE_TYPES.PropertyDefinition,
  AST_NODE_TYPES.TSAsExpression,
  AST_NODE_TYPES.TSSatisfiesExpression,
]);

/** Whether `fn` is returned, or held by the returned object, array or class. */
function returned(fn: FunctionNode): boolean {
  let node: TSESTree.Node = fn;
  while (node.parent && holdsValue.has(node.parent.type)) node = node.parent;
  return node.parent?.type === 'ReturnStatement';
}

/**
 * Whether `write` runs after `factory` returns, the way a method runs after
 * the constructor: the outermost function around it is part of what `factory`
 * returns. A callback that `factory` calls, such as one passed to `map`, has
 * finished by then.
 */
function writtenAfterReturn(
  write: TSESTree.Node,
  factory: TSESTree.Node,
): boolean {
  let outermost: FunctionNode | undefined;
  for (let node = write.parent; node && node !== factory; node = node.parent) {
    if (isFunction(node)) outermost = node;
  }
  return outermost !== undefined && returned(outermost);
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

/** Whether `statement` is `target ??= …;` on its own, for one of `targets`. */
function memoStatement(
  statement: TSESTree.Node,
  targets: ReadonlySet<TSESTree.Node>,
): boolean {
  if (statement.type !== 'ExpressionStatement') return false;
  const { expression } = statement;
  return (
    expression.type === 'AssignmentExpression' &&
    expression.operator === '??=' &&
    targets.has(expression.left)
  );
}

/**
 * Whether a read comes after a top-level `target ??= …;` statement of its own
 * function body. That statement always runs first, so the read never sees the
 * value before it is set.
 */
function readsAfterMemo(
  read: TSESTree.Node,
  targets: ReadonlySet<TSESTree.Node>,
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
      statement.range[1] <= read.range[0] && memoStatement(statement, targets),
  );
}

/** Whether `target` is the target of a destructuring or loop assignment. */
function patternTarget(target: TSESTree.Node): boolean {
  const { parent } = target;
  if (!parent) return false;
  switch (parent.type) {
    case 'ArrayPattern':
    case 'RestElement':
      return true;
    case 'AssignmentPattern':
      return parent.right !== target;
    case 'Property':
      return parent.parent.type === 'ObjectPattern' && parent.value === target;
    case 'ForInStatement':
    case 'ForOfStatement':
      return parent.left === target;
    default:
      return false;
  }
}

/**
 * Whether the uses of a field or variable make it a lazy memo: every write is
 * `target ??= …`, so it never goes back to nullish, and every read is the value
 * of a `??=` or comes after a top-level `target ??= …;` of its own function
 * body. One that nothing reads is a flag, not a memo.
 */
function lazyMemo(uses: readonly TSESTree.Node[]): boolean {
  const targets = new Set(uses);
  let read = false;
  for (const use of uses) {
    const { parent } = use;
    if (!parent) return false;
    if (parent.type === 'AssignmentExpression' && parent.left === use) {
      if (parent.operator !== '??=') return false;
      if (parent.parent.type !== 'ExpressionStatement') read = true;
      continue;
    }
    if (parent.type === 'UpdateExpression' || patternTarget(use)) {
      return false;
    }
    if (!readsAfterMemo(use, targets)) return false;
    read = true;
  }
  return read;
}

/** `this.#name` around each occurrence, or nothing when one is on another object. */
function thisMembers(
  occurrences: readonly TSESTree.PrivateIdentifier[],
): TSESTree.MemberExpression[] | undefined {
  const members: TSESTree.MemberExpression[] = [];
  for (const occurrence of occurrences) {
    const member = occurrence.parent;
    if (
      member.type !== 'MemberExpression' ||
      member.property !== occurrence ||
      member.object.type !== 'ThisExpression'
    ) {
      return undefined;
    }
    members.push(member);
  }
  return members;
}

const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow boolean or optional class fields that change after the constructor, and boolean or optional variables that a returned function changes after its factory returns, which store a phase',
    },
    schema: [],
    messages: {
      phaseFlag:
        'Do not keep a phase in a flag or optional field that changes after the constructor: every reader must know which phase holds. Model the phases as State objects, wait on a one-shot latch, push the fact as an event, or ask the platform for it.',
      phaseVariable:
        'Do not keep a phase in a flag or optional variable that the returned object or function changes after its factory returns: every reader must know which phase holds. Model the phases as State objects, wait on a one-shot latch, push the fact as an event, or ask the platform for it.',
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
      'VariableDeclaration[kind="let"]'(node: TSESTree.VariableDeclaration) {
        for (const variable of context.sourceCode.getDeclaredVariables(node)) {
          const factory = variable.scope.variableScope;
          if (factory.type !== 'function') continue;
          const uses = variable.references
            .filter((reference) => !reference.init)
            .map((reference) => reference.identifier);
          const changedLater = variable.references.some(
            (reference) =>
              reference.isWrite() &&
              writtenAfterReturn(reference.identifier, factory.block),
          );
          const [name] = variable.identifiers;
          if (
            name &&
            changedLater &&
            holdsFlag(services.getTypeAtLocation(name)) &&
            !lazyMemo(uses)
          ) {
            context.report({ node: name, messageId: 'phaseVariable' });
          }
        }
      },
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
            lazyMemo(
              thisMembers(body.occurrences.get(field.name.name) ?? []) ?? [],
            )
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
