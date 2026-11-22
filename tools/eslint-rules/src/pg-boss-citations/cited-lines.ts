import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';

import type { Rule } from 'eslint';

import { type Citation, commentCitations } from './citations.ts';
import { pinnedDist } from './pinned-dist.ts';

/** The pg-boss version that the package.json nearest to `file` pins. */
function pinnedVersion(file: string): string | undefined {
  const manifest = findPackageJSON('./', pathToFileURL(file));
  if (manifest === undefined) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  const dependencies =
    typeof parsed === 'object' && parsed !== null && 'dependencies' in parsed
      ? parsed.dependencies
      : undefined;
  const pin =
    typeof dependencies === 'object' &&
    dependencies !== null &&
    'pg-boss' in dependencies
      ? dependencies['pg-boss']
      : undefined;
  return typeof pin === 'string' ? pin : undefined;
}

/**
 * Each `<file>.js:<n>[-<m>]` citation in a comment names a file of the dist
 * of the pinned pg-boss and lines within it, so a bump of pg-boss that moves
 * the cited code past the end of its file, or removes the file, fails.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require each pg-boss line citation in a comment to name a file of the installed pg-boss dist and lines within it',
    },
    schema: [],
    messages: {
      missingFile: '{{file}} is not in the dist of pg-boss {{version}}.',
      pastEnd:
        '{{file}}:{{range}} is past line {{lines}}, the end of {{file}} in pg-boss {{version}}.',
      notInstalled:
        'pg-boss {{installed}} is installed, but package.json pins {{pinned}}. Run npm install.',
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      'Program:exit'() {
        const found = commentCitations(sourceCode);
        const [first] = found;
        if (first === undefined) return;
        const loc = ({ start, end }: Citation) => ({
          start: sourceCode.getLocFromIndex(start),
          end: sourceCode.getLocFromIndex(end),
        });
        const dist = pinnedDist(context.physicalFilename);
        const pinned = pinnedVersion(context.physicalFilename);
        if (dist.version !== pinned) {
          context.report({
            loc: loc(first),
            messageId: 'notInstalled',
            data: { installed: dist.version, pinned: String(pinned) },
          });
          return;
        }
        for (const citation of found) {
          const lines = dist.lines.get(citation.file);
          if (lines === undefined) {
            context.report({
              loc: loc(citation),
              messageId: 'missingFile',
              data: { file: citation.file, version: dist.version },
            });
          } else if (citation.last > lines) {
            context.report({
              loc: loc(citation),
              messageId: 'pastEnd',
              data: {
                file: citation.file,
                range: citation.range,
                lines: String(lines),
                version: dist.version,
              },
            });
          }
        }
      },
    };
  },
};

export default rule;
