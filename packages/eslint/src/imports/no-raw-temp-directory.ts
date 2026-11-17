import type { Rule } from 'eslint';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
  resolvedVariable,
} from '../authoring/ast.ts';

type Module = 'fs' | 'fs/promises' | 'os' | 'path' | 'crypto';

const MODULES = new Map<string, Module>([
  ['fs', 'fs'],
  ['node:fs', 'fs'],
  ['fs/promises', 'fs/promises'],
  ['node:fs/promises', 'fs/promises'],
  ['os', 'os'],
  ['node:os', 'os'],
  ['path', 'path'],
  ['node:path', 'path'],
  ['path/posix', 'path'],
  ['node:path/posix', 'path'],
  ['path/win32', 'path'],
  ['node:path/win32', 'path'],
  ['crypto', 'crypto'],
  ['node:crypto', 'crypto'],
]);
const MKDTEMP = new Set([
  'mkdtemp',
  'mkdtempSync',
  'mkdtempDisposable',
  'mkdtempDisposableSync',
]);
const TMPDIR = new Set(['tmpdir']);
const JOIN = new Set(['join', 'resolve']);
const RANDOM_UUID = new Set(['randomUUID']);
/** Global calls whose value differs on each run: `Date.now()` and the like. */
const UNIQUE_GLOBAL_CALLS = new Map([
  ['Date', 'now'],
  ['performance', 'now'],
  ['Math', 'random'],
]);

function importedName(specifier: AstNode): string | undefined {
  const imported = specifier['imported'];
  return isType(imported, 'Literal') && typeof imported['value'] === 'string'
    ? imported['value']
    : identifierName(imported);
}

function memberName(member: AstNode): string | undefined {
  const property = member['property'];
  if (member['computed'] !== true) return identifierName(property);
  return isType(property, 'Literal') && typeof property['value'] === 'string'
    ? property['value']
    : undefined;
}

function isMember(node: unknown, object: string, property: string): boolean {
  return (
    isType(node, 'MemberExpression') &&
    identifierName(node['object']) === object &&
    memberName(node) === property
  );
}

/**
 * Code that makes its own temporary directory picks its own cleanup, and the
 * copies drift: one forgets the retry that Windows needs for a file that is
 * still open, another compares the path with what a child process reports,
 * which on macOS is the real path behind the `/var` symlink, and a third never
 * removes it. `TemporaryFiles` of `@zukhruf/fs` gives the real path and
 * removes the directory with the retry. The rule reports `mkdtemp`, and a
 * path under `tmpdir()` with a name that differs on each run (a
 * `randomUUID()`, `Date.now()`, `process.pid`, `performance.now()` or
 * `Math.random()`), whatever then makes it: `mkdir`, `writeFile` or a function
 * that writes files there. A folder with a fixed name is found again by the
 * next run, so it is not temporary. Only the functions of `node:fs`,
 * `node:os`, `node:path` and `node:crypto` count: the rule follows the imports
 * of the file and its `const` declarations, not a value passed in.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a raw temporary directory, made with mkdtemp or named by hand with a unique name under tmpdir(); use TemporaryFiles of @zukhruf/fs',
    },
    schema: [],
    messages: {
      matched:
        'Use `await using dir = await new TemporaryFiles().directory(prefix)` from @zukhruf/fs, or `using dir = new TemporaryFiles().directorySync(prefix)` in code that cannot wait: one standard temporary directory, at its real path, removed with a retry for Windows.',
      uniquePath:
        'A path with a unique name under tmpdir() is a temporary directory made by hand: use `await using dir = await new TemporaryFiles().directory(prefix)` from @zukhruf/fs, or `using dir = new TemporaryFiles().directorySync(prefix)` in code that cannot wait: one standard temporary directory, at its real path, removed with a retry for Windows.',
    },
  },
  create(context) {
    const mkdtempFunctions = new Set<string>();
    const tmpdirFunctions = new Set<string>();
    const joinFunctions = new Set<string>();
    const uuidFunctions = new Set<string>();
    const modules: Record<Module, Set<string>> = {
      fs: new Set(),
      'fs/promises': new Set(),
      os: new Set(),
      path: new Set(),
      // Node and the browsers give `crypto` as a global.
      crypto: new Set(['crypto']),
    };

    function isModule(node: unknown, module: Module): boolean {
      const name = identifierName(node);
      return name !== undefined && modules[module].has(name);
    }

    function isFsObject(node: unknown): boolean {
      if (isModule(node, 'fs') || isModule(node, 'fs/promises')) return true;
      return (
        isType(node, 'MemberExpression') &&
        isModule(node['object'], 'fs') &&
        memberName(node) === 'promises'
      );
    }

    function calls(
      callee: unknown,
      functions: ReadonlySet<string>,
      properties: ReadonlySet<string>,
      isObject: (object: unknown) => boolean,
    ): boolean {
      const name = identifierName(callee);
      if (name !== undefined) return functions.has(name);
      if (!isType(callee, 'MemberExpression')) return false;
      const property = memberName(callee);
      return (
        property !== undefined &&
        properties.has(property) &&
        isObject(callee['object'])
      );
    }

    /** The initial value of a `const` that `node` reads, or `node` itself. */
    function constValue(node: unknown, seen: Set<unknown>): unknown {
      if (!isType(node, 'Identifier') || seen.has(node)) return node;
      seen.add(node);
      const definitions = resolvedVariable(context, node)?.defs ?? [];
      const [definition] = definitions;
      if (
        definitions.length !== 1 ||
        definition?.type !== 'Variable' ||
        definition.parent.kind !== 'const' ||
        definition.node.init == null
      ) {
        return node;
      }
      return constValue(definition.node.init, seen);
    }

    function isUniqueSource(node: AstNode): boolean {
      if (isType(node, 'MemberExpression')) {
        return isMember(node, 'process', 'pid');
      }
      if (!isType(node, 'CallExpression')) return false;
      const callee = node['callee'];
      if (
        calls(callee, uuidFunctions, RANDOM_UUID, (object) =>
          isModule(object, 'crypto'),
        )
      ) {
        return true;
      }
      return [...UNIQUE_GLOBAL_CALLS].some(([object, property]) =>
        isMember(callee, object, property),
      );
    }

    /** Whether the value of `node` holds a part that differs on each run. */
    function isUnique(node: unknown, seen: Set<unknown>): boolean {
      const value = constValue(node, seen);
      if (!isAstNode(value)) return false;
      if (isUniqueSource(value)) return true;
      return Object.entries(value).some(
        ([key, child]) =>
          key !== 'parent' &&
          (Array.isArray(child) ? child : [child]).some(
            (item) => isAstNode(item) && isUnique(item, seen),
          ),
      );
    }

    /**
     * For a path under `tmpdir()`, whether one of its names differs on each
     * run; `undefined` for any other path.
     */
    function temporaryPath(
      node: unknown,
      seen: Set<unknown>,
    ): 'unique' | 'fixed' | undefined {
      const value = constValue(node, seen);
      if (!isType(value, 'CallExpression')) return undefined;
      const callee = value['callee'];
      if (calls(callee, tmpdirFunctions, TMPDIR, (o) => isModule(o, 'os'))) {
        return 'fixed';
      }
      if (!calls(callee, joinFunctions, JOIN, (o) => isModule(o, 'path'))) {
        return undefined;
      }
      const parts = value['arguments'];
      if (!Array.isArray(parts)) return undefined;
      const [parent, ...names] = parts;
      const parentPath = temporaryPath(parent, seen);
      if (parentPath === undefined) return undefined;
      return parentPath === 'unique' ||
        names.some((name) => isUnique(name, seen))
        ? 'unique'
        : 'fixed';
    }

    return {
      ImportDeclaration(node: Rule.Node) {
        if (!isAstNode(node) || !isAstNode(node['source'])) return;
        const source = node['source']['value'];
        const module =
          typeof source === 'string' ? MODULES.get(source) : undefined;
        if (module === undefined) return;
        const specifiers = node['specifiers'];
        if (!Array.isArray(specifiers)) return;
        for (const specifier of specifiers) {
          if (!isAstNode(specifier)) continue;
          const local = identifierName(specifier['local']);
          if (local === undefined) continue;
          if (specifier.type !== 'ImportSpecifier') {
            modules[module].add(local);
            continue;
          }
          const imported = importedName(specifier);
          if (imported === undefined) continue;
          if (module === 'fs' || module === 'fs/promises') {
            if (MKDTEMP.has(imported)) mkdtempFunctions.add(local);
            else if (module === 'fs' && imported === 'promises') {
              modules['fs/promises'].add(local);
            }
          } else if (module === 'os' && TMPDIR.has(imported)) {
            tmpdirFunctions.add(local);
          } else if (module === 'path' && JOIN.has(imported)) {
            joinFunctions.add(local);
          } else if (module === 'crypto' && RANDOM_UUID.has(imported)) {
            uuidFunctions.add(local);
          }
        }
      },
      CallExpression(node: Rule.Node) {
        if (!isAstNode(node)) return;
        const callee = node['callee'];
        if (calls(callee, mkdtempFunctions, MKDTEMP, isFsObject)) {
          context.report({ node, messageId: 'matched' });
          return;
        }
        if (!calls(callee, joinFunctions, JOIN, (o) => isModule(o, 'path'))) {
          return;
        }
        // The join that adds the unique name is reported, not each join under it.
        const [parent] = Array.isArray(node['arguments'])
          ? node['arguments']
          : [];
        if (
          temporaryPath(node, new Set()) === 'unique' &&
          temporaryPath(parent, new Set()) !== 'unique'
        ) {
          context.report({ node, messageId: 'uniquePath' });
        }
      },
    };
  },
};

export default rule;
