import { posix } from 'node:path';

import {
  type Tree,
  formatFiles,
  joinPathFragments,
  logger,
  offsetFromRoot,
  readJson,
  visitNotIgnoredFiles,
  writeJson,
} from '@nx/devkit';
import * as ts from 'typescript';

import {
  hooksProjectJson,
  hooksTsconfig,
  tsconfigSolution,
} from '../../generators/init/files.ts';
import { scriptsTsconfig as backendScriptsTsconfig } from '../../generators/node-app/files.ts';
import { scriptsTsconfig as dbScriptsTsconfig } from '../../generators/prisma/files.ts';
import { projectRootsWith, updateJsonIfChanged } from '../workspace.ts';

const ESLINT_CONFIG = /^eslint\.config\.[cm]?[jt]s$/;
const SCRIPTS_REFERENCE = './tsconfig.scripts.json';

interface Tsconfig {
  include?: string[];
  references?: { path: string }[];
}

/** The root block of init/files.ts up to 0.8.115. */
const oldRootBlock = `  // Files that no tsconfig includes get the default project of typed lint,
  // not a parse error. typescript-eslint refuses '**' here.
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.ts', '.husky/*.ts'],
        },
      },
    },
  },`;

/** The project block of node-app/files.ts (sdk-it.config.ts) and prisma/files.ts (prisma.config.ts) up to 0.8.115. */
const oldProjectBlock = (projectRoot: string, file: string) =>
  `  // No tsconfig of the project includes ${file}, so typed lint gives
  // it the default project. The path is relative to the workspace root, the
  // tsconfigRootDir of @zukhruf/eslint. The block takes each .ts file, as the
  // root block does: one project service serves the process, with the options
  // of the first file it parses.
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['${projectRoot}/${file}'],
        },
      },
    },
  },`;

/** One element of the array an eslint config exports that sets `allowDefaultProject`. */
interface Block {
  path: string;
  /** The text of the file. */
  source: string;
  line: number;
  /** The text to delete: the element, its leading comments and its comma. */
  start: number;
  end: number;
  /** The patterns, or undefined when one is not a string literal. */
  patterns: string[] | undefined;
  /** The text with no whitespace and no trailing commas, to compare with an old template. */
  normalized: string;
}

/** A block that the generators wrote, and the files it hands to the default project. */
interface GeneratedBlock {
  block: Block;
  files: string[];
}

/** A block that stays, so a file it names must get no tsconfig: typed lint refuses a file that both cover. */
interface Blocker {
  block: Block;
  /** Why the block stays, and the step that lets it go. */
  why: string;
}

/** A blocker that names a file, and the pattern that names it ('' when a pattern is not a string literal). */
interface Named {
  blocker: Blocker;
  by: string;
}

/** A project that a generator found by the file it leaves there. */
interface ScriptsProject {
  root: string;
  file: string;
  scriptsTsconfig: (rootOffset: string) => object;
}

/**
 * #5649 (ADR 0022): `sdk-it.config.ts`, `prisma.config.ts` and the Git hooks
 * get the tsconfig that node-app, prisma and init write now, so `tsc`
 * type-checks them and `typecheck` hashes them, and an `allowDefaultProject`
 * block that a generator wrote is deleted once a tsconfig covers its files.
 * typescript-eslint refuses a file that both a tsconfig and
 * `allowDefaultProject` cover, so a file named by a block that stays gets no
 * tsconfig, and one log names both edits (ADR 0017 decision 5). A block that
 * no generator wrote stays, and is logged.
 */
export default async function typeCheckConfigFiles(tree: Tree): Promise<void> {
  const generated: GeneratedBlock[] = [];
  const blockers: Blocker[] = [];
  const rootConfigs = tree
    .children('')
    .filter((name) => name.endsWith('.config.ts'))
    .toSorted();
  const hooks = hookFiles(tree);
  for (const block of eslintBlocks(tree)) {
    const files = generatedFiles(block, [...rootConfigs, ...hooks]);
    if (files === undefined) {
      blockers.push({
        block,
        why: 'no generator wrote it. Delete that entry',
      });
      continue;
    }
    generated.push({ block, files });
    // The root is no project, so no tsconfig covers a root *.config.ts, and
    // the root block stays.
    if (posix.dirname(block.path) === '.' && rootConfigs.length > 0) {
      blockers.push({
        block,
        why: `it stays while no tsconfig includes ${rootConfigs.join(', ')}. Give each a tsconfig, delete the block`,
      });
    }
  }
  const blockerOf = (file: string): Named | undefined =>
    blockers.flatMap((blocker) => {
      const { patterns } = blocker.block;
      if (patterns === undefined) return [{ blocker, by: '' }];
      const pattern = patterns.find((each) => posix.matchesGlob(file, each));
      return pattern === undefined
        ? []
        : [{ blocker, by: ` with '${pattern}'` }];
    })[0];

  const logged = new Set<string>();
  const projects: ScriptsProject[] = [
    ...projectRootsWith(tree, 'sdk-it.config.ts').map((root) => ({
      root,
      file: 'sdk-it.config.ts',
      scriptsTsconfig: backendScriptsTsconfig,
    })),
    ...projectRootsWith(tree, 'prisma.config.ts').map((root) => ({
      root,
      file: 'prisma.config.ts',
      scriptsTsconfig: dbScriptsTsconfig,
    })),
  ];
  for (const project of projects) {
    const step = addScriptsTsconfig(tree, project, blockerOf);
    if (step === undefined) continue;
    warn(step);
    logged.add(joinPathFragments(project.root, project.file));
  }
  const hooksStep = addHooksProject(tree, hooks, blockerOf);
  if (hooksStep !== undefined) {
    warn(hooksStep);
    for (const file of [...hooks, ...rootConfigs]) logged.add(file);
  }

  const deleted: Block[] = [];
  for (const { block, files } of generated) {
    const uncovered = files.filter((file) => !covered(tree, file));
    if (uncovered.length === 0) {
      deleted.push(block);
    } else if (uncovered.some((file) => !logged.has(file))) {
      warn(
        `the allowDefaultProject block of ${block.path}:${block.line} stays, because no tsconfig includes ${uncovered.join(', ')}. Give each a tsconfig that includes it (a tsconfig.scripts.json that its project's tsconfig.json references), then delete the block`,
      );
    }
  }
  for (const [path, blocks] of Map.groupBy(deleted, ({ path }) => path)) {
    const [first] = blocks;
    if (first === undefined) continue;
    tree.write(
      path,
      blocks
        .toSorted((a, b) => b.start - a.start)
        .reduce(
          (text, { start, end }) => text.slice(0, start) + text.slice(end),
          first.source,
        ),
    );
  }
  for (const { block } of blockers) {
    if (generated.some((each) => each.block === block)) continue;
    warn(
      `${block.path}:${block.line} has an allowDefaultProject block${patternsOf(block)} that no generator wrote, so it stays. For each file it names, a tsconfig.scripts.json that includes it, referenced from its project's tsconfig.json, lets you delete the entry; typed lint refuses a file that both cover`,
    );
  }
  await formatFiles(tree);
}

function warn(step: string): void {
  logger.warn(`type-check-config-files: ${step} (#5649, ADR 0022).`);
}

/** The tsconfig.scripts.json of a project that has none, and its reference. Returns the step by hand when it writes nothing. */
function addScriptsTsconfig(
  tree: Tree,
  { root, file, scriptsTsconfig }: ScriptsProject,
  blockerOf: (file: string) => Named | undefined,
): string | undefined {
  const scriptsPath = joinPathFragments(root, 'tsconfig.scripts.json');
  if (tree.exists(scriptsPath)) return undefined;
  const tsconfigPath = joinPathFragments(root, 'tsconfig.json');
  const content = scriptsTsconfig(offsetFromRoot(root));
  const step = `write ${scriptsPath} as ${JSON.stringify(content)} and add {"path":"${SCRIPTS_REFERENCE}"} to the references of ${tsconfigPath}`;
  const target = joinPathFragments(root, file);
  const named = blockerOf(target);
  if (named !== undefined) {
    const { blocker, by } = named;
    return `${target} gets no tsconfig, because the allowDefaultProject block of ${blocker.block.path}:${blocker.block.line} names it${by} and ${blocker.why}, then ${step}`;
  }
  if (!tree.exists(tsconfigPath)) {
    return `${target} gets no tsconfig, because ${root} has no tsconfig.json. Write one, then ${step}`;
  }
  writeJson(tree, scriptsPath, content);
  updateJsonIfChanged<Tsconfig>(tree, tsconfigPath, (tsconfig) => {
    tsconfig.references = unique([
      ...(tsconfig.references ?? []),
      { path: SCRIPTS_REFERENCE },
    ]);
  });
  return undefined;
}

/** The `hooks` project of a repo whose `.ts` hooks have no project. Returns the step by hand when it writes nothing. */
function addHooksProject(
  tree: Tree,
  hooks: string[],
  blockerOf: (file: string) => Named | undefined,
): string | undefined {
  if (hooks.length === 0 || tree.exists('.husky/project.json')) {
    return undefined;
  }
  const step = `write .husky/project.json as ${JSON.stringify(hooksProjectJson)} and .husky/tsconfig.json as ${JSON.stringify(hooksTsconfig)}, and add ${tsconfigSolution.references.map((reference) => JSON.stringify(reference)).join(', ')} to the references of tsconfig.json`;
  const named = hooks.flatMap((file) => {
    const each = blockerOf(file);
    return each === undefined ? [] : [{ file, ...each }];
  });
  const [first] = named;
  if (first !== undefined) {
    const { block, why } = first.blocker;
    return `${named.map(({ file }) => file).join(', ')} get no tsconfig, because the allowDefaultProject block of ${block.path}:${block.line} names them${first.by} and ${why}, then ${step}`;
  }
  if (!tree.exists('tsconfig.json')) {
    return `the hooks get no tsconfig, because the workspace has no tsconfig.json. Write one, then ${step}`;
  }
  writeJson(tree, '.husky/project.json', hooksProjectJson);
  if (!tree.exists('.husky/tsconfig.json')) {
    writeJson(tree, '.husky/tsconfig.json', hooksTsconfig);
  }
  updateJsonIfChanged<Tsconfig>(tree, 'tsconfig.json', (tsconfig) => {
    tsconfig.references = unique([
      ...(tsconfig.references ?? []),
      ...tsconfigSolution.references,
    ]);
  });
  return undefined;
}

/** Whether a tsconfig that the project's tsconfig.json, or the solution's for a hook, references includes the file. */
function covered(tree: Tree, file: string): boolean {
  const directory = posix.dirname(file);
  if (directory === '.') return false;
  if (directory === '.husky') {
    return (
      tree.exists('.husky/tsconfig.json') &&
      referencesOf(tree, 'tsconfig.json').includes('./.husky')
    );
  }
  const scriptsPath = joinPathFragments(directory, 'tsconfig.scripts.json');
  return (
    tree.exists(scriptsPath) &&
    (readJson<Tsconfig>(tree, scriptsPath).include ?? []).includes(
      posix.basename(file),
    ) &&
    referencesOf(tree, joinPathFragments(directory, 'tsconfig.json')).includes(
      SCRIPTS_REFERENCE,
    )
  );
}

function referencesOf(tree: Tree, path: string): string[] {
  if (!tree.exists(path)) return [];
  return (readJson<Tsconfig>(tree, path).references ?? []).map(
    ({ path }) => path,
  );
}

/** The references in order, each path once: a reference that is there stays. */
function unique(references: { path: string }[]): { path: string }[] {
  return [
    ...new Map(
      references.map((reference) => [reference.path, reference]),
    ).values(),
  ];
}

/** Each `.ts` hook in `.husky`. */
function hookFiles(tree: Tree): string[] {
  return tree
    .children('.husky')
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `.husky/${name}`)
    .toSorted();
}

/**
 * The files a block hands to the default project when a generator wrote it,
 * or undefined when none did. The root block's are the root `*.config.ts`
 * files and the hooks it matches.
 */
function generatedFiles(
  block: Block,
  rootFiles: string[],
): string[] | undefined {
  const directory = posix.dirname(block.path);
  if (directory === '.') {
    return block.normalized === normalize(oldRootBlock) ? rootFiles : undefined;
  }
  for (const file of ['sdk-it.config.ts', 'prisma.config.ts']) {
    if (block.normalized === normalize(oldProjectBlock(directory, file))) {
      return [joinPathFragments(directory, file)];
    }
  }
  return undefined;
}

/** The text with no whitespace and no trailing commas: Prettier may have wrapped or re-punctuated it. */
function normalize(text: string): string {
  return text
    .replaceAll(/\s+/g, '')
    .replaceAll(/,(?=[\]}])/g, '')
    .replace(/,$/, '');
}

function patternsOf({ patterns }: Block): string {
  return patterns === undefined
    ? ''
    : ` (${patterns.map((pattern) => `'${pattern}'`).join(', ')})`;
}

/** Each element of an exported config array that sets `allowDefaultProject`, in each eslint config of the repo. */
function eslintBlocks(tree: Tree): Block[] {
  const blocks: Block[] = [];
  visitNotIgnoredFiles(tree, '', (path) => {
    if (!ESLINT_CONFIG.test(posix.basename(path))) return;
    const text = tree.read(path, 'utf8');
    if (text === null || !text.includes('allowDefaultProject')) return;
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
        node.name.text === 'allowDefaultProject'
      ) {
        blocks.push(blockOf(path, source, node));
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  });
  return blocks;
}

/** The array element that holds the property: the config object of the block. */
function blockOf(
  path: string,
  source: ts.SourceFile,
  property: ts.PropertyAssignment,
): Block {
  let element: ts.Node = property;
  while (
    !ts.isSourceFile(element.parent) &&
    !(
      ts.isObjectLiteralExpression(element) &&
      ts.isArrayLiteralExpression(element.parent)
    )
  ) {
    element = element.parent;
  }
  const start = element.getFullStart();
  const comma = /^\s*,/.exec(source.text.slice(element.getEnd()))?.[0] ?? '';
  const end = element.getEnd() + comma.length;
  const { initializer } = property;
  const literals = ts.isArrayLiteralExpression(initializer)
    ? initializer.elements.filter(ts.isStringLiteralLike)
    : [];
  return {
    path,
    source: source.text,
    line:
      source.getLineAndCharacterOfPosition(element.getStart(source)).line + 1,
    start,
    end,
    patterns:
      ts.isArrayLiteralExpression(initializer) &&
      literals.length === initializer.elements.length
        ? literals.map((literal) => literal.text)
        : undefined,
    normalized: normalize(source.text.slice(start, end)),
  };
}
