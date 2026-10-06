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
    const classes: { fields: Map<string, Field>; changed: Set<string> }[] = [];
    const current = () => classes.at(-1);

    const record = (field: Field) => {
      const key = keyOf(field.name);
      if (key) current()?.fields.set(key, field);
    };

    return {
      ClassBody() {
        classes.push({ fields: new Map(), changed: new Set() });
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
        for (const [key, field] of body.fields) {
          if (!body.changed.has(key)) continue;
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
