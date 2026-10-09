import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Rule } from 'eslint';
import * as ts from 'typescript';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
} from '../authoring/ast.ts';
import { isRecord } from '../unknown-values.ts';
import { projectOf } from '../workspace/project-manifest.ts';
import {
  relativeToWorkspace,
  workspaceRootOf,
} from '../workspace/workspace-root.ts';

interface DeclaredEnv {
  readonly mtimeMs: number;
  readonly keys: ReadonlySet<string>;
  readonly error?: string;
}

// Keyed by absolute path. A changed mtime re-parses, so a long-lived ESLint
// process (an editor) picks up an edit to the schema.
const declaredByStartupPath = new Map<string, DeclaredEnv>();

function memberKey(node: AstNode): string | undefined {
  const property = node['property'];
  if (node['computed'] !== true) {
    return identifierName(property);
  }

  if (isType(property, 'Literal') && typeof property['value'] === 'string') {
    return property['value'];
  }

  return undefined;
}

function isProcessEnvMember(node: unknown): boolean {
  return (
    isType(node, 'MemberExpression') &&
    memberKey(node) === 'env' &&
    identifierName(node['object']) === 'process'
  );
}

function startupFileOption(options: readonly unknown[]): string {
  const [option] = options;
  const startupFile = isRecord(option) ? option['startupFile'] : undefined;
  // meta.defaultOptions supplies it and the schema keeps it a string.
  if (typeof startupFile !== 'string') {
    throw new TypeError(
      'no-undeclared-process-env: the startupFile option must be a string.',
    );
  }
  return startupFile;
}

/**
 * A relative `startupFile` is read from the linted file's project, so the same
 * schema is found whether ESLint runs from the project folder (`nx lint`) or
 * from the workspace root (an editor). An absolute one is used as is.
 */
function resolveStartupPath(
  context: Rule.RuleContext,
  startupFile: string,
): string {
  const filename = resolve(context.cwd, context.physicalFilename);
  const base =
    projectOf(filename)?.root ??
    workspaceRootOf(dirname(filename)) ??
    context.cwd;
  return resolve(base, startupFile);
}

function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }

  return undefined;
}

function zodObjectLiteral(
  node: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'z' &&
    node.expression.name.text === 'object'
  ) {
    const [schema] = node.arguments;
    return schema && ts.isObjectLiteralExpression(schema) ? schema : undefined;
  }

  return undefined;
}

function parseDeclaredEnvKeys(startupPath: string): Set<string> {
  const source = readFileSync(startupPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    startupPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const keys = new Set<string>();
  let foundEnvSchema = false;

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'env' &&
      node.initializer
    ) {
      const objectLiteral = zodObjectLiteral(node.initializer);
      if (objectLiteral) {
        foundEnvSchema = true;
        for (const property of objectLiteral.properties) {
          if (
            ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property) ||
            ts.isMethodDeclaration(property)
          ) {
            const key = staticPropertyName(property.name);
            if (key) {
              keys.add(key);
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!foundEnvSchema) {
    throw new Error(
      `Could not find "const env = z.object(...)" in ${startupPath}`,
    );
  }

  return keys;
}

function declaredEnvOf(startupPath: string): DeclaredEnv {
  try {
    const { mtimeMs } = statSync(startupPath);
    const cached = declaredByStartupPath.get(startupPath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached;
    }

    const entry: DeclaredEnv = {
      mtimeMs,
      keys: parseDeclaredEnvKeys(startupPath),
    };
    declaredByStartupPath.set(startupPath, entry);
    return entry;
  } catch (error) {
    const entry: DeclaredEnv = {
      mtimeMs: -1,
      keys: new Set(),
      error: error instanceof Error ? error.message : String(error),
    };
    declaredByStartupPath.set(startupPath, entry);
    return entry;
  }
}

/**
 * The startup file validates the environment once, at boot, with
 * `const env = z.object({...})`. A `process.env` key read without being
 * declared there skips that check: a missing or malformed value surfaces late,
 * at the read, instead of failing the boot. The schema is parsed with the
 * TypeScript compiler API, so the rule needs no type information.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every process.env key to be declared in the startup env schema',
    },
    messages: {
      startupUnavailable:
        'Could not validate process.env usage because the startup env schema is unavailable: {{error}}',
      undeclaredEnv:
        'Declare {{key}} in {{startupFile}} before using process.env.{{key}}.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          startupFile: {
            type: 'string',
          },
        },
      },
    ],
    defaultOptions: [{ startupFile: 'src/startup.ts' }],
  },
  create(context) {
    const startupPath = resolveStartupPath(
      context,
      startupFileOption(context.options),
    );
    const declared = declaredEnvOf(startupPath);
    let reportedStartupError = false;

    return {
      MemberExpression(node) {
        if (
          !isType(node, 'MemberExpression') ||
          !isProcessEnvMember(node['object'])
        ) {
          return;
        }

        const key = memberKey(node);
        const property = node['property'];
        if (!key || !isAstNode(property)) {
          return;
        }

        if (declared.error) {
          if (reportedStartupError) {
            return;
          }
          reportedStartupError = true;
          context.report({
            node: property,
            messageId: 'startupUnavailable',
            data: { error: declared.error },
          });
          return;
        }

        if (declared.keys.has(key)) {
          return;
        }

        context.report({
          node: property,
          messageId: 'undeclaredEnv',
          data: {
            key,
            startupFile: relativeToWorkspace(startupPath),
          },
        });
      },
    };
  },
};

export default rule;
