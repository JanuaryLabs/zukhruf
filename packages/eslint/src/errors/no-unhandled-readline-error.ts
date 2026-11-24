import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';
import { unionConstituents } from 'ts-api-utils';
import * as ts from 'typescript';

import { eslintRule } from '../authoring/rule-module.ts';

/**
 * The modules of @types/node that declare `createInterface`. @types/node 26
 * declares it under `node:` and re-exports it from the plain names; older
 * releases declare it under the plain names and re-export it from `node:`.
 */
const READLINE_MODULES = new Set([
  'readline',
  'readline/promises',
  'node:readline',
  'node:readline/promises',
]);

/** The EventEmitter methods that add a listener and return the emitter. */
const LISTENER_METHODS = new Set([
  'on',
  'once',
  'addListener',
  'prependListener',
  'prependOnceListener',
]);

/** How many helpers deep the rule follows an interface passed as an argument. */
const HELPER_DEPTH = 4;

/** `createInterface` as a module of @types/node declares it. */
function isReadlineCreateInterface(declaration: ts.Declaration): boolean {
  if (
    !ts.isFunctionDeclaration(declaration) ||
    declaration.name?.text !== 'createInterface'
  ) {
    return false;
  }
  for (let node: ts.Node = declaration; ; node = node.parent) {
    if (ts.isSourceFile(node)) return false;
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      return READLINE_MODULES.has(node.name.text);
    }
  }
}

/** `'error'`, written as a string or as a template with no expression. */
const isErrorEvent = (node: ts.Node | undefined) =>
  node !== undefined &&
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
  node.text === 'error';

/** `Symbol.asyncIterator`, the key of `lines[Symbol.asyncIterator]()`. */
const isAsyncIteratorKey = (node: ts.Expression) =>
  ts.isPropertyAccessExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === 'Symbol' &&
  node.name.text === 'asyncIterator';

/** The name that a declaration or an assignment target binds. */
function boundName(
  node: ts.Node,
): ts.Identifier | ts.PrivateIdentifier | undefined {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node;
  if (ts.isPropertyAccessExpression(node)) return node.name;
  return undefined;
}

/** The checks of one file, which read the types of its program. */
class ErrorListeners {
  readonly #checker: ts.TypeChecker;

  constructor(checker: ts.TypeChecker) {
    this.#checker = checker;
  }

  /**
   * Whether the input of this readline call is a stream that the code can
   * also write to: a net.Socket, a TLS socket, a PassThrough or another
   * Duplex. Linux resets such a socket when its peer closes with data the
   * code wrote and the peer did not read. A Readable that only reads, such
   * as a child's stdout or stderr, and process.stdin (a tty.ReadStream) get
   * no such reset: a probe on node:26-alpine saw 0 of 20 errors on a child's
   * stdout, and 20 of 20 once the parent also wrote into it. An input that
   * has no type (`any`) is skipped, because the rule cannot see what it is.
   */
  readsDuplex(call: ts.CallExpression): boolean {
    const [first] = call.arguments;
    if (first === undefined) return false;
    const argument = this.#checker.getTypeAtLocation(first);
    const option = argument.getProperty('input');
    const input = this.#checker.getNonNullableType(
      option === undefined
        ? argument
        : this.#checker.getTypeOfSymbolAtLocation(option, first),
    );
    if (input.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
    return unionConstituents(input).every(
      (part) =>
        part.getProperty('read') !== undefined &&
        part.getProperty('write') !== undefined &&
        part.getProperty('on') !== undefined &&
        // Only a tty.ReadStream declares setRawMode.
        part.getProperty('setRawMode') === undefined,
    );
  }

  /** Whether `call` is readline's createInterface, by the function it resolves to. */
  isCreateInterface(call: ts.CallExpression): boolean {
    // The name first, also through a renamed import: resolving the
    // signature of every call in a file costs more.
    const callee = ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name
      : call.expression;
    const symbol = this.#checker.getSymbolAtLocation(callee);
    const target =
      symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
        ? this.#checker.getAliasedSymbol(symbol)
        : symbol;
    if (target?.getName() !== 'createInterface') return false;
    const declaration = this.#checker
      .getResolvedSignature(call)
      ?.getDeclaration();
    return declaration !== undefined && isReadlineCreateInterface(declaration);
  }

  /**
   * Whether something listens for 'error' on the interface that `value`
   * gives: a listener on it, chained or on a name that holds it, its async
   * iterator (`for await`, `[Symbol.asyncIterator]()`), whose listener of
   * node:events turns an error into a rejection, or a function of the
   * project that does one of these with the parameter it is given. `seen`
   * holds the bindings already followed, so an interface that two names
   * hold, or a helper that calls itself, ends.
   */
  listened(value: ts.Node, seen: Set<ts.Symbol>, depth = 0): boolean {
    let current = value;
    for (;;) {
      const parent = current.parent;
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent)
      ) {
        current = parent;
        continue;
      }
      if (
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === current
      ) {
        const call = parent.parent;
        if (!ts.isCallExpression(call) || call.expression !== parent) {
          return false;
        }
        if (ts.isElementAccessExpression(parent)) {
          return isAsyncIteratorKey(parent.argumentExpression);
        }
        if (!LISTENER_METHODS.has(parent.name.text)) return false;
        if (isErrorEvent(call.arguments[0])) return true;
        // A listener method returns the emitter, so the chain goes on.
        current = call;
        continue;
      }
      if (ts.isForOfStatement(parent)) {
        return (
          parent.expression === current && parent.awaitModifier !== undefined
        );
      }
      if (ts.isCallExpression(parent) && parent.expression !== current) {
        return this.#helperListens(
          parent,
          parent.arguments.findIndex((argument) => argument === current),
          seen,
          depth,
        );
      }
      if (
        (ts.isVariableDeclaration(parent) ||
          ts.isPropertyDeclaration(parent)) &&
        parent.initializer === current
      ) {
        return this.#bindingListened(boundName(parent.name), seen, depth);
      }
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === current
      ) {
        return this.#bindingListened(boundName(parent.left), seen, depth);
      }
      return false;
    }
  }

  /**
   * Whether a read of the variable, parameter or field that `name` declares
   * or writes listens. Reads are found in the file by the symbol they resolve
   * to, so a field is found through `this.#lines` in any method.
   */
  #bindingListened(
    name: ts.Identifier | ts.PrivateIdentifier | undefined,
    seen: Set<ts.Symbol>,
    depth: number,
  ): boolean {
    if (name === undefined) return false;
    const symbol = this.#checker.getSymbolAtLocation(name);
    if (symbol === undefined || seen.has(symbol)) return false;
    seen.add(symbol);
    const reads: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (
        node !== name &&
        (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
        node.text === name.text &&
        this.#checker.getSymbolAtLocation(node) === symbol
      ) {
        const { parent } = node;
        reads.push(
          ts.isPropertyAccessExpression(parent) && parent.name === node
            ? parent
            : node,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(name.getSourceFile());
    return reads.some((read) => this.listened(read, seen, depth));
  }

  /**
   * Whether the function that `call` calls listens on its parameter at
   * `index`, read from its body. A function that only a declaration file
   * declares, such as `once` of node:events, has no body, so it does not
   * count; `once` also removes its listener when the event comes.
   */
  #helperListens(
    call: ts.CallExpression,
    index: number,
    seen: Set<ts.Symbol>,
    depth: number,
  ) {
    if (index < 0 || depth >= HELPER_DEPTH) return false;
    const declaration = this.#checker
      .getResolvedSignature(call)
      ?.getDeclaration();
    if (
      declaration === undefined ||
      !ts.isFunctionLike(declaration) ||
      !('body' in declaration) ||
      declaration.body === undefined
    ) {
      return false;
    }
    const parameter = declaration.parameters[index];
    return (
      parameter !== undefined &&
      parameter.dotDotDotToken === undefined &&
      ts.isIdentifier(parameter.name) &&
      this.#bindingListened(parameter.name, seen, depth + 1)
    );
  }
}

const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow a readline interface over a socket or another Duplex that nothing listens on for 'error'",
    },
    schema: [],
    messages: {
      unhandled:
        "readline emits the errors of its input again on this interface, and nothing listens for 'error' on it, so a reset of the socket throws an uncaught exception, even when the socket has its own listener. Linux resets a socket when its peer closes with data it did not read, and macOS does not, so the gap passes locally and fails CI. Listen for 'error' on the interface where you make it, pass it to a function that does, or read it with `for await`.",
    },
  },
  create(context) {
    // Throws the standard "requires type information" error without typed lint.
    const services = ESLintUtils.getParserServices(context);
    const listeners = new ErrorListeners(services.program.getTypeChecker());
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const call = services.esTreeNodeToTSNodeMap.get(node);
        if (
          listeners.isCreateInterface(call) &&
          listeners.readsDuplex(call) &&
          !listeners.listened(call, new Set())
        ) {
          context.report({ node, messageId: 'unhandled' });
        }
      },
    };
  },
});

export default eslintRule(rule);
