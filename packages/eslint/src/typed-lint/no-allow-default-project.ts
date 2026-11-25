import type { Rule } from 'eslint';

import { isRecord, stringsAt } from '../unknown-values.ts';

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow typescript-eslint's allowDefaultProject, which lints a file that no tsconfig type-checks",
    },
    schema: [],
    messages: {
      defaultProject:
        "allowDefaultProject {{globs}} lets typed lint parse a file that no tsconfig includes through typescript-eslint's default project, so lint passes while tsc never type-checks the file and Nx's typecheck inputs leave it out. Include the file in a tsconfig that the project's tsconfig.json references, such as a type-check-only tsconfig.scripts.json, then remove allowDefaultProject.",
    },
  },
  create(context) {
    // Read from the file's own config: allowDefaultProject is set per file
    // block, so one linted file can allow the default project and another not.
    const { parserOptions } = context.languageOptions;
    const projectService = isRecord(parserOptions)
      ? parserOptions['projectService']
      : undefined;
    const globs = stringsAt(projectService, 'allowDefaultProject');
    if (globs.length === 0) return {};
    return {
      Program() {
        context.report({
          loc: { line: 1, column: 0 },
          messageId: 'defaultProject',
          data: {
            globs: `[${globs.map((glob) => `'${glob}'`).join(', ')}]`,
          },
        });
      },
    };
  },
};

export default rule;
