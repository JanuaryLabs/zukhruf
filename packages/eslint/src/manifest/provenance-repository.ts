import { dirname, relative, resolve, sep } from 'node:path';

import type { Rule } from 'eslint';

import { isAstNode, isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';
import { workspaceRootOf } from '../workspace/workspace-root.ts';

/** The string value of a JSON node, or `undefined` when it is not a string literal. */
function stringValue(node: unknown): string | undefined {
  return isType(node, 'JSONLiteral') && typeof node['value'] === 'string'
    ? node['value']
    : undefined;
}

/**
 * npm provenance signs the GitHub repository that runs the workflow, and the
 * npm registry refuses the publish when the manifest's `repository.url` does
 * not match it. `npm publish` turns a string `repository` into
 * `{ type: 'git', url }`, so a non-empty string passes. A `directory` is not
 * part of that check, but a manifest below the workspace root names its folder
 * in `directory`, so the npm page links to the package, not the repository
 * root. npm does not publish a manifest with `"private": true`, so the rule
 * does not check it. The rule reads only the manifest and its path: it cannot
 * know the Git remote, so it does not check which repository the URL names.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require repository.url, and repository.directory below the workspace root, in a package.json that npm can publish, because npm provenance refuses the publish without them',
    },
    schema: [],
    messages: {
      missingRepository:
        'This package.json can be published but has no "repository". npm provenance refuses the publish unless "repository.url" matches the GitHub repository of the workflow. Add {"type": "git", "url": "https://github.com/<owner>/<repo>"{{directory}}}.',
      missingUrl:
        '"repository" has no non-empty "url". npm provenance refuses the publish unless "repository.url" matches the GitHub repository of the workflow. Set it to "https://github.com/<owner>/<repo>".',
      wrongDirectory:
        '"repository.directory" is {{actual}}, but this package.json is in "{{expected}}" of the workspace. Set "directory" to "{{expected}}", so the npm page links to the package.',
    },
  },
  create(context) {
    const filename = resolve(context.physicalFilename);
    const folder = dirname(filename);
    const root = workspaceRootOf(folder);
    const expected =
      root === undefined ? '' : relative(root, folder).split(sep).join('/');
    return {
      'JSONExpressionStatement > JSONObjectExpression'(manifest: Rule.Node) {
        if (!isType(manifest, 'JSONObjectExpression')) return;
        const fields = new Map(objectProperties(manifest));
        const isPrivate = fields.get('private')?.['value'];
        if (isType(isPrivate, 'JSONLiteral') && isPrivate['value'] === true) {
          return;
        }
        const property = fields.get('repository');
        if (property === undefined) {
          context.report({
            node: manifest,
            messageId: 'missingRepository',
            data: {
              directory: expected === '' ? '' : `, "directory": "${expected}"`,
            },
          });
          return;
        }
        const repository = property['value'];
        const parts = new Map(objectProperties(repository));
        const url =
          stringValue(repository) ?? stringValue(parts.get('url')?.['value']);
        if (url === undefined || url.trim() === '') {
          context.report({ node: property, messageId: 'missingUrl' });
        }
        if (expected === '') return;
        const directory = parts.get('directory')?.['value'];
        const directoryText = stringValue(directory);
        if (directoryText === expected) return;
        context.report({
          node: isAstNode(directory) ? directory : property,
          messageId: 'wrongDirectory',
          data: {
            actual:
              directory === undefined
                ? 'missing'
                : JSON.stringify(directoryText ?? null),
            expected,
          },
        });
      },
    };
  },
};

export default rule;
