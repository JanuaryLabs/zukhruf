import type { Rule } from 'eslint';

import { identifierName, isAstNode, isType } from '../authoring/ast.ts';
import { inRoots, isTestFile } from '../authoring/path-scope.ts';
import { isRecord, stringsAt } from '../unknown-values.ts';

/**
 * A packaged app launched from the GUI does not inherit the shell's PATH: on
 * macOS it gets launchd's `/usr/bin:/bin:/usr/sbin:/sbin`. A subprocess spawned
 * by bare name (`spawn('docker', …)`) works in every terminal run and fails with
 * ENOENT in every packaged build, even while the tool is installed and running.
 * `roots` scopes the rule to the code that ships inside the app; dev tooling
 * may use PATH freely.
 */

const SUBPROCESS_MODULES = new Set([
  'nano-spawn',
  'node:child_process',
  'child_process',
]);

// exec/execSync receive a whole shell command line; the others receive argv[0].
const SHELL_COMMAND_FUNCTIONS = new Set(['exec', 'execSync']);
const CHILD_PROCESS_FUNCTIONS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]);

function literalCommand(argument: unknown): string | undefined {
  if (isType(argument, 'Literal') && typeof argument['value'] === 'string') {
    return argument['value'];
  }
  if (isType(argument, 'TemplateLiteral')) {
    const expressions = argument['expressions'];
    const quasis = argument['quasis'];
    if (
      Array.isArray(expressions) &&
      expressions.length === 0 &&
      Array.isArray(quasis) &&
      quasis.length === 1
    ) {
      const [quasi] = quasis;
      if (isType(quasi, 'TemplateElement')) {
        const value = quasi['value'];
        if (isRecord(value) && typeof value['cooked'] === 'string') {
          return value['cooked'];
        }
      }
    }
  }
  return undefined;
}

/** The text before the first whitespace: the binary of a shell command line. */
function firstToken(command: string): string {
  const end = command.search(/\s/);
  return end === -1 ? command : command.slice(0, end);
}

function isBareName(command: string): boolean {
  return (
    command.length > 0 && !command.includes('/') && !command.includes('\\')
  );
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'disallow spawning a subprocess by bare binary name — packaged apps run under launchd PATH where it never resolves',
    },
    messages: {
      noBareSpawn:
        'Subprocess command "{{command}}" resolves via PATH, and a GUI-launched packaged app inherits launchd\'s PATH (/usr/bin:/bin:/usr/sbin:/sbin) where it will ENOENT even while the tool is running — dev never reproduces this because terminal runs leak the shell PATH. Use an absolute path, or talk to the tool\'s daemon or API directly (for Docker, the Engine API socket instead of the docker CLI).',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          roots: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    ],
    defaultOptions: [{ roots: [] }],
  },
  create(context) {
    const filename = context.physicalFilename;
    if (isTestFile(filename)) return {};
    if (!inRoots(filename, stringsAt(context.options[0], 'roots'))) {
      return {};
    }

    // local binding name -> the subprocess function it refers to
    const trackedBindings = new Map<string, string>();
    const trackedNamespaces = new Set<string>();

    function checkCall(node: Rule.Node, spawnFunction: string): void {
      if (!isAstNode(node)) return;
      const callArguments = node['arguments'];
      if (!Array.isArray(callArguments)) return;
      const command = literalCommand(callArguments[0]);
      if (command === undefined) return;
      const binary = SHELL_COMMAND_FUNCTIONS.has(spawnFunction)
        ? firstToken(command)
        : command;
      if (isBareName(binary)) {
        context.report({
          node,
          messageId: 'noBareSpawn',
          data: { command: binary },
        });
      }
    }

    return {
      ImportDeclaration(node: Rule.Node) {
        if (!isAstNode(node)) return;
        const source = node['source'];
        if (
          !isType(source, 'Literal') ||
          typeof source['value'] !== 'string' ||
          !SUBPROCESS_MODULES.has(source['value'])
        ) {
          return;
        }
        const specifiers = node['specifiers'];
        if (!Array.isArray(specifiers)) return;
        for (const specifier of specifiers) {
          const local = isType(specifier, 'ImportDefaultSpecifier')
            ? identifierName(specifier['local'])
            : undefined;
          if (local !== undefined) {
            // nano-spawn's default export is argv-style spawn.
            trackedBindings.set(local, 'spawn');
            continue;
          }
          if (isType(specifier, 'ImportSpecifier')) {
            const imported = identifierName(specifier['imported']);
            const localName = identifierName(specifier['local']);
            if (
              imported !== undefined &&
              localName !== undefined &&
              CHILD_PROCESS_FUNCTIONS.has(imported)
            ) {
              trackedBindings.set(localName, imported);
            }
            continue;
          }
          if (isType(specifier, 'ImportNamespaceSpecifier')) {
            const namespace = identifierName(specifier['local']);
            if (namespace !== undefined) trackedNamespaces.add(namespace);
          }
        }
      },
      CallExpression(node: Rule.Node) {
        if (!isAstNode(node)) return;
        const callee = node['callee'];
        const calleeName = identifierName(callee);
        if (calleeName !== undefined) {
          const spawnFunction = trackedBindings.get(calleeName);
          if (spawnFunction !== undefined) checkCall(node, spawnFunction);
          return;
        }
        if (isType(callee, 'MemberExpression') && callee['computed'] !== true) {
          const namespace = identifierName(callee['object']);
          const method = identifierName(callee['property']);
          if (
            namespace !== undefined &&
            method !== undefined &&
            trackedNamespaces.has(namespace) &&
            CHILD_PROCESS_FUNCTIONS.has(method)
          ) {
            checkCall(node, method);
          }
        }
      },
    };
  },
};

export default rule;
