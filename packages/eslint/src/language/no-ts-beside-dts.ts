import { existsSync } from 'node:fs';
import { basename, extname } from 'node:path';

import type { Rule } from 'eslint';

/**
 * The declaration file that TypeScript drops when the program includes a
 * source file of the same base name, by the extension of that source file. A
 * `.cts` does not drop its `.d.cts` (measured with TypeScript 6.0).
 */
const SHADOWED_DECLARATION: ReadonlyMap<string, string> = new Map([
  ['.ts', '.d.ts'],
  ['.tsx', '.d.ts'],
  ['.mts', '.d.mts'],
]);

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a TypeScript file beside a declaration file of the same base name, which TypeScript then stops loading',
    },
    schema: [],
    messages: {
      shadowed:
        '{{declaration}} sits beside this file, so TypeScript reads it as the declaration file of this file and stops loading it: its globals and module augmentations disappear. Rename {{declaration}}, for example to vite-env.d.ts.',
    },
  },
  create(context) {
    const file = context.physicalFilename;
    const extension = extname(file);
    const declarationExtension = SHADOWED_DECLARATION.get(extension);
    if (declarationExtension === undefined) return {};
    const declaration = `${file.slice(0, -extension.length)}${declarationExtension}`;
    return {
      Program(node) {
        if (existsSync(declaration)) {
          context.report({
            node,
            loc: { line: 1, column: 0 },
            messageId: 'shadowed',
            data: { declaration: basename(declaration) },
          });
        }
      },
    };
  },
};

export default rule;
