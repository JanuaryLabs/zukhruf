import {
  ESLintUtils,
  type ParserServices,
  type TSESLint,
  type TSESTree,
} from '@typescript-eslint/utils';
import * as ts from 'typescript';

import { eslintRule } from '../authoring/rule-module.ts';
import { isRecord } from '../unknown-values.ts';
import { DECLARATIONS, isTestCase } from './declarations.ts';

const ASSERTS = new Set(['assert', 'expect']);
/** A `new` or a call of a built-in makes a value for the test, not a subject under test. */
const GLOBALS = new Set([
  'JSON',
  'Object',
  'String',
  'Number',
  'Boolean',
  'Array',
  'console',
  'Math',
  'Promise',
  'Symbol',
  'Reflect',
  'Date',
  'Buffer',
  'BigInt',
  'RegExp',
  'Error',
  'Map',
  'Set',
  'structuredClone',
  'encodeURIComponent',
  'decodeURIComponent',
  'parseInt',
  'parseFloat',
  'isNaN',
  'setTimeout',
  'clearTimeout',
  'URL',
  'TextEncoder',
  'TextDecoder',
  'Uint8Array',
  'process',
  'globalThis',
  'AbortSignal',
  'RangeError',
  'TypeError',
  'SyntaxError',
  'AggregateError',
  'DOMException',
  'AbortController',
  'DataView',
  'ArrayBuffer',
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'WeakMap',
  'WeakSet',
  'Infinity',
  'NaN',
  'Atomics',
  'SharedArrayBuffer',
  'Intl',
  'Headers',
  'Response',
  'Request',
  'Blob',
  'FormData',
  'URLSearchParams',
]);
/**
 * Where test support is declared: `src/testing` of a package, `@zukhruf/testing`
 * as installed and as its source in this workspace, and `TemporaryFiles` of
 * `@zukhruf/fs`. A value of such a type is a fixture, not the result of an act.
 */
const TEST_SUPPORT =
  /\/src\/testing\/|\/packages\/testing\/|@zukhruf\/testing|temporary-files/i;
/** The declaration files of the standard library, which declare built-in classes such as `Map`. */
const STANDARD_LIBRARY = /\/node_modules\/typescript\/lib\//;

type Node = TSESTree.Node;
type FunctionNode =
  TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;
type Call = TSESTree.CallExpression | TSESTree.NewExpression;
/**
 * What a value that the test declares before the loop is: `data` written out,
 * a `function`, an `arrange` value (a fixture or a fresh subject) or the
 * `result` of an act.
 */
type Kind = 'data' | 'function' | 'arrange' | 'result';

function isNode(value: unknown): value is Node {
  return isRecord(value) && typeof value['type'] === 'string';
}

function isFunction(node: Node | null | undefined): node is FunctionNode {
  return (
    node?.type === 'ArrowFunctionExpression' ||
    node?.type === 'FunctionExpression'
  );
}

/** The name a value expression starts from: `docker` for `(await docker.images.list()).length`, `this` for `this.x`. */
function rootOf(node: Node | null | undefined): string | undefined {
  let current = node;
  for (;;) {
    switch (current?.type) {
      case 'Identifier':
        return current.name;
      case 'ThisExpression':
        return 'this';
      case 'MemberExpression':
        current = current.object;
        break;
      case 'CallExpression':
        current = current.callee;
        break;
      case 'TSNonNullExpression':
      case 'TSAsExpression':
        current = current.expression;
        break;
      case 'AwaitExpression':
        current = current.argument;
        break;
      default:
        return undefined;
    }
  }
}

function unwrap(node: Node | null | undefined): Node | undefined {
  let current = node ?? undefined;
  for (;;) {
    switch (current?.type) {
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
        current = current.expression;
        break;
      case 'AwaitExpression':
        current = current.argument;
        break;
      default:
        return current;
    }
  }
}

function patternNames(
  pattern: Node | null | undefined,
  names = new Set<string>(),
): Set<string> {
  if (pattern) {
    for (const identifier of patternIdentifiers(pattern)) {
      names.add(identifier.name);
    }
  }
  return names;
}

function rowNamesOf(loop: TSESTree.ForOfStatement): Set<string> {
  return patternNames(
    loop.left.type === 'VariableDeclaration'
      ? loop.left.declarations[0]?.id
      : loop.left,
  );
}

/** A value reference, not the key of a property or of an object literal. */
function isReference(identifier: TSESTree.Identifier): boolean {
  const { parent } = identifier;
  if (
    parent.type === 'MemberExpression' &&
    parent.property === identifier &&
    !parent.computed
  ) {
    return false;
  }
  return !(
    parent.type === 'Property' &&
    parent.key === identifier &&
    !parent.computed &&
    (!parent.shorthand || parent.value !== identifier)
  );
}

function propertyName(node: Node): string | undefined {
  return node.type === 'MemberExpression' && node.property.type === 'Identifier'
    ? node.property.name
    : undefined;
}

/** `assert.equal(…)`, `expect(…)`, `assertValid(…)` or `t.assert.equal(…)`. */
function isAssertion(call: Call): boolean {
  if (call.type !== 'CallExpression') return false;
  const root = rootOf(call.callee) ?? '';
  const { callee } = call;
  return (
    ASSERTS.has(root) ||
    /^(assert|expect)[A-Z]/.test(root) ||
    (callee.type === 'MemberExpression' &&
      propertyName(callee.object) === 'assert')
  );
}

/** A call that declares a test or a suite, also a `t.test(…)` subtest: such a loop is prefer-each's. */
function declares(call: Call): boolean {
  if (call.type !== 'CallExpression') return false;
  const name = propertyName(call.callee);
  return (
    DECLARATIONS.has(rootOf(call.callee) ?? '') ||
    name === 'test' ||
    name === 'it'
  );
}

/** The nodes of a file, read through the parser's visitor keys. */
class Tree {
  readonly #keys: TSESLint.SourceCode.VisitorKeys;

  constructor(keys: TSESLint.SourceCode.VisitorKeys) {
    this.#keys = keys;
  }

  /** `root` and each node below it, nested functions included. */
  *nodes(root: Node): Generator<Node> {
    yield root;
    for (const key of this.#keys[root.type] ?? []) {
      const value: unknown = isRecord(root) ? root[key] : undefined;
      const children: unknown[] = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (isNode(child)) yield* this.nodes(child);
      }
    }
  }

  refersTo(root: Node, names: ReadonlySet<string>): boolean {
    for (const node of this.nodes(root)) {
      if (
        node.type === 'Identifier' &&
        names.has(node.name) &&
        isReference(node)
      ) {
        return true;
      }
    }
    return false;
  }

  calls(root: Node): Call[] {
    return [...this.nodes(root)].filter(
      (node): node is Call =>
        node.type === 'CallExpression' || node.type === 'NewExpression',
    );
  }
}

/** The names of a file that a subject can come from. */
class FileNames {
  /** Each imported local name and the module it comes from. */
  readonly #imports = new Map<string, string>();
  /** The functions and classes of the module scope. */
  readonly moduleFunctions = new Set<string>();
  /** The functions and classes declared outside every test case, at any depth. */
  readonly outerFunctions = new Set<string>();
  /** The value of the first `const` of each name, so a loop over a named table reads its rows. */
  readonly #constants = new Map<string, Node>();

  constructor(program: TSESTree.Program, tree: Tree) {
    for (const statement of program.body) {
      if (statement.type === 'ImportDeclaration') {
        for (const specifier of statement.specifiers) {
          this.#imports.set(specifier.local.name, statement.source.value);
        }
      }
      const declaration =
        statement.type === 'ExportNamedDeclaration'
          ? statement.declaration
          : statement;
      if (
        (declaration?.type === 'FunctionDeclaration' ||
          declaration?.type === 'ClassDeclaration') &&
        declaration.id
      ) {
        this.moduleFunctions.add(declaration.id.name);
      }
      if (declaration?.type === 'VariableDeclaration') {
        for (const declarator of declaration.declarations) {
          if (
            declarator.id.type === 'Identifier' &&
            makesFunction(declarator)
          ) {
            this.moduleFunctions.add(declarator.id.name);
          }
        }
      }
    }
    for (const name of this.moduleFunctions) this.outerFunctions.add(name);
    for (const node of tree.nodes(program)) {
      if (
        node.type === 'VariableDeclarator' &&
        node.id.type === 'Identifier' &&
        node.init &&
        node.parent.kind === 'const' &&
        !this.#constants.has(node.id.name)
      ) {
        const value = unwrap(node.init);
        if (value !== undefined) this.#constants.set(node.id.name, value);
      }
      const name =
        node.type === 'FunctionDeclaration'
          ? node.id?.name
          : node.type === 'VariableDeclarator' &&
              node.id.type === 'Identifier' &&
              makesFunction(node)
            ? node.id.name
            : undefined;
      if (name !== undefined && !insideTestCase(node)) {
        this.outerFunctions.add(name);
      }
    }
  }

  constant(name: string): Node | undefined {
    return this.#constants.get(name);
  }

  /** A name imported from a package or a file of the workspace, not from Node. */
  importsSubject(name: string): boolean {
    const source = this.#imports.get(name);
    return source !== undefined && !source.startsWith('node:');
  }
}

function makesFunction(declarator: TSESTree.VariableDeclarator): boolean {
  return (
    isFunction(declarator.init) || declarator.init?.type === 'ClassExpression'
  );
}

function insideTestCase(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (isTestCase(current)) return true;
  }
  return false;
}

interface Facts {
  /** A fixture: declared with `using`, or of a type that test support declares. */
  readonly fixture: boolean;
  /** An instance of a class of the workspace or of a package, not of the standard library. */
  readonly instance: boolean;
}

/**
 * The facts of a value that only its declaration or its type gives. The
 * declaration gives `using`; the types need the program of a typed run.
 */
class ValueFacts {
  readonly #services: ParserServices;

  constructor(
    context: Readonly<TSESLint.RuleContext<string, readonly unknown[]>>,
  ) {
    // A JavaScript file, or a run without type information, has no program:
    // the rule then reads only what the syntax of the linted file shows.
    this.#services = ESLintUtils.getParserServices(context, true);
  }

  of(declarator: TSESTree.VariableDeclarator, name: string): Facts {
    const { kind } = declarator.parent;
    const declared = kind === 'using' || kind === 'await using';
    const typed = this.#typeFacts(declarator, name);
    return { fixture: declared || typed.fixture, instance: typed.instance };
  }

  #typeFacts(declarator: TSESTree.VariableDeclarator, name: string): Facts {
    const none = { fixture: false, instance: false };
    const services = this.#services;
    const identifier = patternIdentifiers(declarator.id).find(
      (node) => node.name === name,
    );
    if (!services.program || identifier === undefined) return none;
    const checker = services.program.getTypeChecker();
    const type = checker.getNonNullableType(
      services.getTypeAtLocation(identifier),
    );
    const symbol = type.getSymbol() ?? type.aliasSymbol;
    let fixture = false;
    let instance = false;
    for (const declaration of symbol?.getDeclarations() ?? []) {
      const file = declaration.getSourceFile().fileName;
      if (TEST_SUPPORT.test(file)) fixture = true;
      if (ts.isClassDeclaration(declaration) && !STANDARD_LIBRARY.test(file)) {
        instance = true;
      }
    }
    return { fixture, instance };
  }
}

function* patternIdentifiers(pattern: Node): Generator<TSESTree.Identifier> {
  switch (pattern.type) {
    case 'Identifier':
      yield pattern;
      break;
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        yield* patternIdentifiers(
          property.type === 'RestElement' ? property.argument : property.value,
        );
      }
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements) {
        if (element) yield* patternIdentifiers(element);
      }
      break;
    case 'AssignmentPattern':
      yield* patternIdentifiers(pattern.left);
      break;
    case 'RestElement':
      yield* patternIdentifiers(pattern.argument);
      break;
    default:
      break;
  }
}

/**
 * A for-of loop directly in a test case, over a table of two or more rows
 * written out in the test or in a `const`, whose body asserts and declares no
 * test. It is a table of cases when a row reaches a fresh subject: a `new`, a
 * function of the file or of a package, or a value the test arranged, not the
 * result that the test's act made.
 */
class CaseLoop {
  readonly #loop: TSESTree.ForOfStatement;
  readonly #test: FunctionNode;
  readonly #table: TSESTree.ArrayExpression;
  readonly #tree: Tree;
  readonly #names: FileNames;
  readonly #values: ValueFacts;
  readonly #rows: ReadonlySet<string>;
  /** The rows and each value the loop body derives from them. */
  readonly #tainted: ReadonlySet<string>;
  readonly #bodyLocals: ReadonlySet<string>;
  /** The bindings of loops around the test case: a test declared for each row of a table. */
  readonly #outerRows: ReadonlySet<string>;
  /** Each value the test declares before the loop. */
  readonly #before = new Map<string, TSESTree.VariableDeclarator>();
  readonly #assertionsOutside: Call[];
  readonly #kinds = new Map<string, Kind>();
  readonly #facts = new Map<string, Facts>();

  static of(
    loop: TSESTree.ForOfStatement,
    tree: Tree,
    names: FileNames,
    values: ValueFacts,
  ): CaseLoop | undefined {
    const test = enclosingTestCase(loop);
    if (test === undefined || enclosingFunction(loop) !== test) {
      return undefined;
    }
    let table = unwrap(loop.right);
    if (table?.type === 'Identifier') table = names.constant(table.name);
    if (table?.type !== 'ArrayExpression' || table.elements.length < 2) {
      return undefined;
    }
    const calls = tree.calls(loop.body);
    if (!calls.some(isAssertion) || calls.some(declares)) return undefined;
    return new CaseLoop(loop, test, table, tree, names, values);
  }

  private constructor(
    loop: TSESTree.ForOfStatement,
    test: FunctionNode,
    table: TSESTree.ArrayExpression,
    tree: Tree,
    names: FileNames,
    values: ValueFacts,
  ) {
    this.#loop = loop;
    this.#test = test;
    this.#table = table;
    this.#tree = tree;
    this.#names = names;
    this.#values = values;
    this.#rows = rowNamesOf(loop);
    const locals = new Set<string>();
    for (const node of tree.nodes(loop.body)) {
      if (node.type === 'VariableDeclarator') patternNames(node.id, locals);
    }
    this.#bodyLocals = locals;
    for (const node of tree.nodes(test.body)) {
      if (
        node.type === 'VariableDeclarator' &&
        node.range[1] <= loop.range[0]
      ) {
        for (const name of patternNames(node.id)) this.#before.set(name, node);
      }
    }
    const outerRows = new Set<string>();
    for (let node: Node | undefined = test.parent; node; node = node.parent) {
      if (node.type === 'ForOfStatement') {
        for (const name of rowNamesOf(node)) outerRows.add(name);
      }
    }
    this.#outerRows = outerRows;
    this.#assertionsOutside = tree
      .calls(test.body)
      .filter(
        (call) =>
          isAssertion(call) &&
          !(call.range[0] >= loop.range[0] && call.range[1] <= loop.range[1]),
      );
    const tainted = new Set(this.#rows);
    for (let grew = true; grew;) {
      grew = false;
      for (const node of tree.nodes(loop.body)) {
        if (
          node.type !== 'VariableDeclarator' ||
          !node.init ||
          !tree.refersTo(node.init, tainted)
        ) {
          continue;
        }
        for (const name of patternNames(node.id)) {
          if (!tainted.has(name)) {
            tainted.add(name);
            grew = true;
          }
        }
      }
    }
    this.#tainted = tainted;
  }

  runsCases(): boolean {
    const rowCalls = this.#tree
      .calls(this.#loop.body)
      .filter(
        (call) =>
          !isAssertion(call) &&
          (call.arguments.some((argument) =>
            this.#tree.refersTo(argument, this.#tainted),
          ) ||
            (call.callee.type === 'Identifier' &&
              this.#rows.has(call.callee.name))),
      );
    if (rowCalls.length === 0) return false;
    if (!this.#table.elements.every((row) => this.#writtenOut(row, true))) {
      return false;
    }
    if (this.#table.elements.some((row) => this.#holdsResult(row))) {
      return false;
    }
    return rowCalls.some((call) => this.#reachesSubject(call));
  }

  /** A row written out: no `await`, no `this`, no call of a value of the test, no result of the act. */
  #writtenOut(
    row: TSESTree.Expression | TSESTree.SpreadElement | null,
    top: boolean,
  ): boolean {
    if (row === null) return true;
    switch (row.type) {
      case 'AwaitExpression':
      case 'ThisExpression':
        return false;
      case 'CallExpression':
        return (
          !top ||
          (!this.#before.has(rootOf(row.callee) ?? '') &&
            !row.arguments.some((argument) =>
              this.#before
                .keys()
                .some(
                  (name) =>
                    this.#isResult(name) &&
                    this.#tree.refersTo(argument, new Set([name])),
                ),
            ))
        );
      case 'Identifier':
      case 'MemberExpression':
        return !this.#isResult(rootOf(row), 'row');
      case 'SpreadElement':
        return this.#writtenOut(row.argument, false);
      default:
        return true;
    }
  }

  /** A row such as `[inFlight, late]` that lists results of the act. */
  #holdsResult(
    row: TSESTree.Expression | TSESTree.SpreadElement | null,
  ): boolean {
    return (
      row?.type === 'ArrayExpression' &&
      row.elements.some(
        (element) =>
          (element?.type === 'Identifier' ||
            element?.type === 'MemberExpression') &&
          this.#isResult(rootOf(element), 'row'),
      )
    );
  }

  #reachesSubject(call: Call): boolean {
    const usesRow =
      call.arguments.some((argument) =>
        this.#tree.refersTo(argument, this.#rows),
      ) ||
      (call.callee.type === 'Identifier' && this.#rows.has(call.callee.name));
    if (call.type === 'NewExpression') {
      return usesRow && !GLOBALS.has(rootOf(call.callee) ?? '');
    }
    let base: Node = call.callee;
    while (base.type === 'MemberExpression') base = base.object;
    if (base.type !== 'Identifier' && base.type !== 'ThisExpression') {
      return false;
    }
    const root = rootOf(call.callee);
    if (root === undefined || GLOBALS.has(root)) return false;
    const subject =
      (usesRow && this.#freshSubject(root)) || this.#actsOnInstance(call, root);
    return (
      subject &&
      !call.arguments.some(
        (argument) =>
          (argument.type === 'Identifier' ||
            argument.type === 'MemberExpression') &&
          this.#isResult(rootOf(argument)),
      )
    );
  }

  #freshSubject(root: string): boolean {
    const value = unwrap(this.#before.get(root)?.init);
    return (
      this.#rows.has(root) ||
      this.#bodyLocals.has(root) ||
      this.#names.moduleFunctions.has(root) ||
      this.#names.importsSubject(root) ||
      this.#outerRows.has(root) ||
      this.#names.outerFunctions.has(root) ||
      (isFunction(value) && this.#makesSubject(value)) ||
      (this.#before.has(root) && this.#kindFor(root, 'subject') === 'arrange')
    );
  }

  /**
   * A method call with a row on an instance of a class that the test made
   * with `new` or a plain function. An instance that a method of another value
   * returns, such as `docker.containers.create(…)`, reads the act's product.
   * A value the loop body derives from the row counts as the row.
   */
  #actsOnInstance(call: TSESTree.CallExpression, root: string): boolean {
    return (
      this.#before.has(root) &&
      call.callee.type === 'MemberExpression' &&
      call.callee.object.type === 'Identifier' &&
      this.#factsOf(root).instance &&
      this.#acquired(root) &&
      call.arguments.some((argument) =>
        this.#tree.refersTo(argument, this.#tainted),
      )
    );
  }

  #acquired(name: string): boolean {
    const value = unwrap(this.#before.get(name)?.init);
    if (value?.type === 'NewExpression') {
      return !GLOBALS.has(rootOf(value.callee) ?? '');
    }
    return (
      value?.type === 'CallExpression' &&
      value.callee.type === 'Identifier' &&
      !this.#before.has(value.callee.name)
    );
  }

  /** A local factory: its parameters, or those of a function it returns, reach a `new` or a function of the file or of a package. */
  #makesSubject(factory: FunctionNode): boolean {
    const parameters = new Set<string>();
    for (const node of this.#tree.nodes(factory)) {
      if (isFunction(node)) {
        for (const parameter of node.params) {
          patternNames(parameter, parameters);
        }
      }
    }
    return this.#tree.calls(factory.body).some((call) => {
      if (isAssertion(call)) return false;
      const root = rootOf(call.callee) ?? '';
      const subject =
        call.type === 'NewExpression'
          ? !GLOBALS.has(root)
          : this.#names.moduleFunctions.has(root) ||
            this.#names.importsSubject(root);
      return (
        subject &&
        call.arguments.some((argument) =>
          this.#tree.refersTo(argument, parameters),
        )
      );
    });
  }

  #isResult(
    name: string | undefined,
    purpose: 'subject' | 'row' = 'subject',
  ): boolean {
    return (
      name !== undefined &&
      this.#before.has(name) &&
      this.#kindFor(name, purpose) === 'result'
    );
  }

  /** A fixture that the data flow counts as a result is still arranged, as the subject of a call. */
  #kindFor(name: string, purpose: 'subject' | 'row'): Kind {
    const kind = this.#kindOf(name);
    return kind === 'result' &&
      purpose === 'subject' &&
      this.#factsOf(name).fixture
      ? 'arrange'
      : kind;
  }

  #factsOf(name: string): Facts {
    const known = this.#facts.get(name);
    if (known !== undefined) return known;
    const declarator = this.#before.get(name);
    const facts = declarator
      ? this.#values.of(declarator, name)
      : { fixture: false, instance: false };
    this.#facts.set(name, facts);
    return facts;
  }

  #kindOf(name: string): Kind {
    const known = this.#kinds.get(name);
    if (known !== undefined) return known;
    // A value whose kind depends on itself is a result.
    this.#kinds.set(name, 'result');
    const kind = this.#classify(name);
    this.#kinds.set(name, kind);
    return kind;
  }

  #classify(name: string): Kind {
    const declarator = this.#before.get(name);
    const value = unwrap(declarator?.init);
    if (declarator === undefined || value === undefined) return 'result';
    if (isFunction(value)) return 'function';
    const computed = this.#tree
      .nodes(value)
      .some(
        (node) =>
          node.type === 'CallExpression' ||
          node.type === 'NewExpression' ||
          node.type === 'AwaitExpression' ||
          node.type === 'ThisExpression',
      );
    if (!computed && !this.#readsNonData(value, name)) return 'data';
    if (
      (value.type !== 'NewExpression' && value.type !== 'CallExpression') ||
      this.#before.has(rootOf(value.callee) ?? '') ||
      GLOBALS.has(rootOf(value.callee) ?? '') ||
      value.arguments.some((argument) => this.#readsNonData(argument, name))
    ) {
      return 'result';
    }
    // A value handed to a call before the loop was acted on, and one asserted on outside the loop is a result.
    const handed = this.#tree
      .calls(this.#test.body)
      .some(
        (call) =>
          call.range[0] >= declarator.range[1] &&
          call.range[1] <= this.#loop.range[0] &&
          !isAssertion(call) &&
          call.arguments.some((argument) =>
            this.#tree.refersTo(argument, new Set([name])),
          ),
      );
    const asserted = this.#assertionsOutside.some((assertion) =>
      assertion.arguments.some((argument) =>
        this.#tree.refersTo(argument, new Set([name])),
      ),
    );
    return handed || asserted ? 'result' : 'arrange';
  }

  /** Whether `node` reads a value of the test, other than `self`, that is not written-out data. */
  #readsNonData(node: Node, self: string): boolean {
    let reads = false;
    for (const each of this.#tree.nodes(node)) {
      if (
        each.type === 'Identifier' &&
        each.name !== self &&
        this.#before.has(each.name) &&
        isReference(each) &&
        this.#kindOf(each.name) !== 'data'
      ) {
        reads = true;
      }
    }
    return reads;
  }
}

function enclosingTestCase(node: Node): FunctionNode | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (isTestCase(current) && isFunction(current)) return current;
  }
  return undefined;
}

/** A loop inside a callback of the test, such as one that `waitFor` retries, cannot become `test.each`. */
function enclosingFunction(node: Node): Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunction(current) || current.type === 'FunctionDeclaration') {
      return current;
    }
  }
  return undefined;
}

/**
 * A loop inside one test that runs a table of independent cases stops at the
 * first case that fails, so the run hides the cases after it. `test.each` of
 * `@zukhruf/parameterized-test` declares each case as its own test, with its
 * own name and result. xUnit Test Patterns (Meszaros) names the loop a Tabular
 * Test, a variation of the Parameterized Test.
 *
 * A loop is reported when its rows are written out and a row reaches a fresh
 * subject, not when it checks several parts of one result of the test's act.
 * With type information the rule also counts a fixture of test support as
 * arranged and a method call on a class instance as an act; without it, it
 * reads only the syntax. Of nested loops, only the outermost one is reported.
 */
const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow a loop inside one test that runs a table of independent cases',
    },
    schema: [],
    messages: {
      tabularTest:
        'This loop runs a table of independent cases inside one test, so the first failing case stops the test and hides the rest. Declare each case as its own test with test.each of @zukhruf/parameterized-test.',
    },
  },
  create(context) {
    const loops: TSESTree.ForOfStatement[] = [];
    return {
      ForOfStatement(loop) {
        loops.push(loop);
      },
      'Program:exit'(program: TSESTree.Program) {
        const tree = new Tree(context.sourceCode.visitorKeys);
        const names = new FileNames(program, tree);
        const values = new ValueFacts(context);
        const reported = new Set<Node>();
        for (const loop of loops) {
          if (CaseLoop.of(loop, tree, names, values)?.runsCases()) {
            reported.add(loop);
          }
        }
        for (const loop of reported) {
          if (!hasAncestorIn(loop, reported)) {
            context.report({ node: loop, messageId: 'tabularTest' });
          }
        }
      },
    };
  },
});

function hasAncestorIn(node: Node, nodes: ReadonlySet<Node>): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (nodes.has(current)) return true;
  }
  return false;
}

export default eslintRule(rule);
