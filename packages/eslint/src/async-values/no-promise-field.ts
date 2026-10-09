import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';
import {
  intersectionConstituents,
  isSymbolFlagSet,
  isThenableType,
  isTypeReference,
  unionConstituents,
} from 'ts-api-utils';
import * as ts from 'typescript';

import { eslintRule } from '../authoring/rule-module.ts';

/** What the walk over one field's type reads from the program. */
interface Walk {
  checker: ts.TypeChecker;
  program: ts.Program;
  node: ts.Node;
}

/** A file of TypeScript's lib, or of a package under node_modules. */
const isLibraryFile = (program: ts.Program, file: ts.SourceFile) =>
  program.isSourceFileDefaultLibrary(file) ||
  program.isSourceFileFromExternalLibrary(file);

/**
 * The result of `Promise.withResolvers()`, from the lib or a polyfill. It keeps
 * its promise in a property, so a check of the type itself misses it.
 */
function isPromiseWithResolvers({ program }: Walk, type: ts.Type): boolean {
  const symbol = type.getSymbol();
  return (
    symbol?.getName() === 'PromiseWithResolvers' &&
    symbol
      .getDeclarations()
      ?.some((declaration) =>
        isLibraryFile(program, declaration.getSourceFile()),
      ) === true
  );
}

/**
 * The type arguments of a generic type (`Map<K, V>`) and of a type alias
 * (`Record<K, V>`, `Partial<T>`), which TypeScript keeps apart.
 */
function typeArguments({ checker }: Walk, type: ts.Type): readonly ts.Type[] {
  return [
    ...(isTypeReference(type) ? checker.getTypeArguments(type) : []),
    ...(type.aliasTypeArguments ?? []),
  ];
}

/** How many properties deep the walk follows records, so a recursive generic record ends. */
const RECORD_DEPTH = 4;

/**
 * A shape of data that the project declares. A class is not one: the rule
 * checks the fields of each class itself. A library's type is not one either:
 * its promises, such as a stream writer's `closed`, belong to the library. A
 * function type is one, but it has no properties, so nothing in it is found.
 */
function isProjectRecord({ program }: Walk, type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (!symbol || isSymbolFlagSet(symbol, ts.SymbolFlags.Class)) return false;
  const declarations = symbol.getDeclarations();
  return (
    declarations !== undefined &&
    declarations.length > 0 &&
    declarations.every(
      (declaration) => !isLibraryFile(program, declaration.getSourceFile()),
    )
  );
}

/**
 * What a record holds: its properties and its index signatures. A method is a
 * function type, so the walk finds no promise in it.
 */
function recordMembers({ checker }: Walk, type: ts.Type): ts.Type[] {
  return [
    ...checker
      .getPropertiesOfType(type)
      .map((property) => checker.getTypeOfSymbol(property)),
    ...checker.getIndexInfosOfType(type).map((info) => info.type),
  ];
}

/**
 * Whether `type` is a promise, or carries one as a type argument
 * (`Map<string, Promise<X>>`, `Promise<X>[]`) or as a member of a record the
 * project declares, in any member of a union or an intersection. A function
 * type is not entered: a field that holds `() => Promise<X>` holds the
 * memoized function this rule asks for.
 *
 * `path` holds only the types on the way to this one: a type that one branch
 * met at the depth limit must still be walked when another branch meets it
 * higher up.
 */
function holdsPromise(
  walk: Walk,
  type: ts.Type,
  depth = 0,
  path = new Set<ts.Type>(),
): boolean {
  if (path.has(type)) return false;
  path.add(type);
  try {
    if (isThenableType(walk.checker, walk.node, type)) return true;
    return unionConstituents(type)
      .flatMap((part) => intersectionConstituents(part))
      .some(
        (part) =>
          isPromiseWithResolvers(walk, part) ||
          typeArguments(walk, part).some((argument) =>
            holdsPromise(walk, argument, depth, path),
          ) ||
          (depth < RECORD_DEPTH &&
            isProjectRecord(walk, part) &&
            recordMembers(walk, part).some((member) =>
              holdsPromise(walk, member, depth + 1, path),
            )),
      );
  } finally {
    path.delete(type);
  }
}

/** The node that names a field: its key, or a parameter property's binding. */
function fieldName(
  node:
    | TSESTree.PropertyDefinition
    | TSESTree.AccessorProperty
    | TSESTree.TSAbstractPropertyDefinition
    | TSESTree.TSAbstractAccessorProperty
    | TSESTree.TSParameterProperty,
): TSESTree.Node {
  if (node.type !== 'TSParameterProperty') return node.key;
  return node.parameter.type === 'AssignmentPattern'
    ? node.parameter.left
    : node.parameter;
}

const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow class fields that hold a promise, which caches its rejection and races when reset',
    },
    schema: [],
    messages: {
      promiseField:
        'Do not keep a promise in a field: it caches a rejection, can reject before anyone awaits it, and races when it is reset. Memoize the async function (p-memoize), model the phase as a State object, or wait on a one-shot latch.',
    },
  },
  defaultOptions: [],
  create(context) {
    // Throws the standard "requires type information" error without typed lint.
    const services = ESLintUtils.getParserServices(context);
    const { program } = services;
    const checker = program.getTypeChecker();
    const check = (node: Parameters<typeof fieldName>[0]) => {
      const name = fieldName(node);
      const type = services.getTypeAtLocation(name);
      const walk = {
        checker,
        program,
        node: services.esTreeNodeToTSNodeMap.get(name),
      };
      if (holdsPromise(walk, type)) {
        context.report({ node, messageId: 'promiseField' });
      }
    };
    return {
      PropertyDefinition: check,
      AccessorProperty: check,
      TSAbstractPropertyDefinition: check,
      TSAbstractAccessorProperty: check,
      TSParameterProperty: check,
    };
  },
});

export default eslintRule(rule);
