import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, posix } from 'node:path';

import {
  type FileData,
  type ProjectFileMap,
  type ProjectGraph,
  type ProjectGraphProjectNode,
  workspaceRoot,
} from '@nx/devkit';
import * as ts from 'typescript';

import { isRecord } from '../unknown-values.ts';
import {
  reachableProjects,
  workspacePackageName,
} from '../workspace/cached-project-graph.ts';
import type { FileMapReader } from '../workspace/nx-file-map.ts';
import { readJson } from '../workspace/project-manifest.ts';
import { subpathTargets } from './package-exports.ts';

/** A JavaScript or TypeScript module: the walk reads its imports. */
const SCRIPT = /\.[cm]?[jt]sx?$/;

/** Files that import no module, so the walk loses nothing when it does not read them. */
const INERT =
  /\.(?:json|css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|txt|md|wasm)$/;

/** Loads that a bundler resolves from a pattern, not from one specifier. */
const PATTERN_LOADS = [
  /\bimport\.meta\.glob\s*\(/,
  /\bnew\s+URL\s*\(\s*['"`][^'"`]*['"`]\s*,\s*import\.meta\.url/,
  /\brequire\.context\s*\(/,
];

/** One string literal as the whole first argument of a call. */
const LITERAL_ARGUMENT = /^\s*(?:'[^'\n\\]*'|"[^"\n\\]*")\s*[,)]/;

/** The extensions a bundler tries, in its order, after the path itself. */
const EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
];

/** The TypeScript sources a `.js` name stands for. */
const SOURCES_OF: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/**
 * Whether `text` loads a module that no one specifier names: a pattern
 * (`import.meta.glob`, `new URL(…, import.meta.url)`, `require.context`) or
 * an `import()` of anything but one string literal, which vite and esbuild
 * bundle as a glob when it is a template or a concatenation.
 */
function loadsByPattern(text: string): boolean {
  if (PATTERN_LOADS.some((pattern) => pattern.test(text))) return true;
  for (const call of text.matchAll(/\bimport\s*\(/g)) {
    const rest = text.slice(call.index + call[0].length);
    if (!LITERAL_ARGUMENT.test(rest)) return true;
  }
  return false;
}

/** The text of a workspace file, or `undefined` when the file map names a file that is gone. */
function readSource(file: string): string | undefined {
  try {
    return readFileSync(join(workspaceRoot, file), 'utf8');
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') return undefined;
    throw error;
  }
}

/** The npm name of a bare specifier: `@scope/name` or `name`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return (
    specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)
  ).join('/');
}

/** `path` with the minimatch metacharacters escaped, so the glob matches that path only. */
function literalGlob(path: string): string {
  return path.replaceAll(/[*?[\]{}()!+@#\\]/g, String.raw`\$&`);
}

/** What one specifier of a file leads to. */
type Resolution =
  /** Files the bundle loads, and the workspace project that holds them. */
  | {
      readonly kind: 'files';
      readonly files: string[];
      readonly project?: string | undefined;
    }
  /** A workspace package whose subpath maps to no source file: all of it counts. */
  | { readonly kind: 'project'; readonly project: string }
  /** An npm package or a Node builtin: Nx counts it from the file's own data. */
  | { readonly kind: 'outside' }
  /** A specifier the walk cannot follow. */
  | { readonly kind: 'unknown'; readonly project?: string | undefined };

export interface BundleReachOptions {
  /** The `ignoredFiles` that Nx's check gets, as workspace-relative globs. */
  readonly ignoredFiles: readonly string[];
  /** The `buildTargets` that Nx's check gets; Nx picks the first the app has. */
  readonly buildTargets?: readonly string[] | undefined;
}

/**
 * The modules that a bundled app's bundle loads, followed import by import
 * from the app's shipped files, and the files of the projects it inlines that
 * the bundle never loads.
 *
 * The walk starts at the app's files that Nx's dependency-checks reads (its
 * build inputs, less `ignoredFiles`). It reads each module's imports with
 * `ts.preProcessFile`: static, type-only, `export … from`, side-effect, a
 * literal `import()` and `require()`. A relative import leads to the file the
 * bundler finds in Nx's file map; a workspace package's name and subpath
 * through its `exports` (or `main` and `module`), under every condition; a
 * `#x` through the importing package's `imports`.
 *
 * When the walk cannot follow something, a whole project counts, as it does
 * in Nx's own check: a subpath with no source file, a `#x` or a relative path
 * that leads to no file, a bare specifier that is no npm package, builtin or
 * workspace package (a tsconfig `paths` alias), a load by pattern, a file the
 * walk cannot read, and a workspace project that Nx's file data names and no
 * followed import accounts for. Every fallback counts more files, never
 * fewer: a manifest that misses a package fails when the app is deployed.
 */
export class BundleReach {
  /**
   * The files of the projects Nx's check walks that the bundle never loads,
   * as workspace-relative `ignoredFiles` globs. A folder whose files are all
   * unloaded is one `folder/**` glob.
   */
  readonly unloaded: readonly string[];

  constructor(
    graph: ProjectGraph,
    fileMap: ProjectFileMap,
    app: ProjectGraphProjectNode,
    { ignoredFiles, buildTargets = ['build'] }: BundleReachOptions,
    nx: FileMapReader,
  ) {
    const target = buildTargets.find((name) => app.data.targets?.[name]);
    // Nx's check reads nothing for an app without a build target.
    if (target === undefined) {
      this.unloaded = [];
      return;
    }
    const nxJson = nx.readNxJsonFromDisk();
    const counted = (node: ProjectGraphProjectNode): FileData[] =>
      nx.filterUsingGlobPatterns(node.data.root, fileMap[node.name] ?? [], [
        ...(node.data.targets?.[target]
          ? nx.getTargetInputs(nxJson, node, target).selfInputs
          : ['{projectRoot}/**/*']),
        ...ignoredFiles.map((glob) => `!${glob}`),
      ]);
    const reached = new ModuleWalk(graph, fileMap, counted, nx).from(app);
    this.unloaded = unloadedGlobs(graph, fileMap, app, counted, reached);
  }
}

/** The breadth-first walk over the module graph, from an app's counted files. */
class ModuleWalk {
  private readonly files = new Map<
    string,
    { readonly project: string; readonly data: FileData }
  >();
  private readonly packages = new Map<string, ProjectGraphProjectNode>();
  private readonly npm: ReadonlySet<string>;
  private readonly reached = new Set<string>();
  private readonly whole = new Set<string>();
  private readonly queue: string[] = [];
  private readonly graph: ProjectGraph;
  private readonly counted: (node: ProjectGraphProjectNode) => FileData[];
  private readonly nx: FileMapReader;

  constructor(
    graph: ProjectGraph,
    fileMap: ProjectFileMap,
    counted: (node: ProjectGraphProjectNode) => FileData[],
    nx: FileMapReader,
  ) {
    this.graph = graph;
    this.counted = counted;
    this.nx = nx;
    for (const [project, files] of Object.entries(fileMap)) {
      for (const data of files) this.files.set(data.file, { project, data });
    }
    for (const node of Object.values(graph.nodes)) {
      const name = workspacePackageName(node);
      if (name !== undefined) this.packages.set(name, node);
    }
    this.npm = new Set(
      Object.values(graph.externalNodes ?? {}).map(
        ({ data }) => data.packageName,
      ),
    );
  }

  /** Every file of the file map that the bundle of `app` loads. */
  from(app: ProjectGraphProjectNode): ReadonlySet<string> {
    for (const { file } of this.counted(app)) this.reach(file);
    for (let file = this.queue.shift(); file; file = this.queue.shift()) {
      this.read(file);
    }
    return this.reached;
  }

  private reach(file: string): void {
    if (this.reached.has(file)) return;
    this.reached.add(file);
    this.queue.push(file);
  }

  private reachWhole(name: string): void {
    const node = this.graph.nodes[name];
    if (!node || this.whole.has(name)) return;
    this.whole.add(name);
    for (const { file } of this.counted(node)) this.reach(file);
  }

  private read(file: string): void {
    const entry = this.files.get(file);
    if (!entry) return;
    const { project, data } = entry;
    const accounted = new Set([project]);
    const script = SCRIPT.test(file);
    const text = script ? readSource(file) : '';
    let blind =
      (!script && !INERT.test(file)) ||
      text === undefined ||
      loadsByPattern(text);
    const specifiers = script
      ? ts.preProcessFile(text ?? '', true, true).importedFiles
      : [];
    for (const { fileName } of specifiers) {
      const resolution = this.resolve(file, project, fileName);
      if (resolution.kind === 'outside') continue;
      if (resolution.project !== undefined) accounted.add(resolution.project);
      if (resolution.kind === 'files') {
        for (const target of resolution.files) this.reach(target);
      } else if (resolution.kind === 'project') {
        this.reachWhole(resolution.project);
      } else {
        blind = true;
        if (resolution.project !== undefined) {
          this.reachWhole(resolution.project);
        }
      }
    }
    if (blind) this.reachWhole(project);
    for (const dependency of data.deps ?? []) {
      const target = this.nx.fileDataDepTarget(dependency);
      if (blind || !accounted.has(target)) this.reachWhole(target);
    }
  }

  private resolve(file: string, project: string, raw: string): Resolution {
    // A query (`?worker`, `?url`) names the same file to vite.
    const specifier = raw.replace(/(?<=.)\?.*$/, '');
    if (specifier.startsWith('.')) return this.relative(file, specifier);
    if (specifier.startsWith('#')) {
      const files = this.mapped(project, 'imports', specifier);
      return files.length > 0
        ? { kind: 'files', files, project }
        : { kind: 'unknown' };
    }
    if (isBuiltin(specifier)) return { kind: 'outside' };
    if (specifier.startsWith('/') || specifier.includes(':')) {
      return { kind: 'unknown' };
    }
    const name = packageNameOf(specifier);
    const node = this.packages.get(name);
    if (!node) {
      return this.npm.has(name) ? { kind: 'outside' } : { kind: 'unknown' };
    }
    const rest = specifier.slice(name.length);
    const files = this.mapped(node.name, 'exports', rest ? `.${rest}` : '.');
    return files.length > 0
      ? { kind: 'files', files, project: node.name }
      : { kind: 'project', project: node.name };
  }

  /** The file the bundler finds for a relative specifier, or the project whose folder holds the path. */
  private relative(file: string, specifier: string): Resolution {
    const base = posix.normalize(posix.join(posix.dirname(file), specifier));
    const extension = posix.extname(base);
    const found = [
      base,
      ...(SOURCES_OF[extension] ?? []).map(
        (source) => base.slice(0, -extension.length) + source,
      ),
      ...EXTENSIONS.map((added) => base + added),
      ...EXTENSIONS.map((added) => `${base}/index${added}`),
    ].find((candidate) => this.files.has(candidate));
    if (found !== undefined) {
      return {
        kind: 'files',
        files: [found],
        project: this.files.get(found)?.project,
      };
    }
    return { kind: 'unknown', project: this.projectHolding(base) };
  }

  /** The source files of the workspace that `subpath` of `project`'s package maps to. */
  private mapped(
    project: string,
    field: 'exports' | 'imports',
    subpath: string,
  ): string[] {
    const root = this.graph.nodes[project]?.data.root ?? '.';
    const manifest = readJson(join(workspaceRoot, root, 'package.json'));
    return subpathTargets(manifest, field, subpath)
      .map((target) => posix.join(root, target))
      .filter((target) => this.files.has(target));
  }

  /** The project whose folder is the deepest one to hold `path`. */
  private projectHolding(path: string): string | undefined {
    let holder: ProjectGraphProjectNode | undefined;
    for (const node of Object.values(this.graph.nodes)) {
      const { root } = node.data;
      const holds = root === '.' || root === '' || path.startsWith(`${root}/`);
      if (holds && root.length >= (holder?.data.root.length ?? -1)) {
        holder = node;
      }
    }
    return holder?.name;
  }
}

/**
 * The counted modules of the projects Nx's check walks for `app` that the
 * bundle never loads, as globs. A folder becomes one `folder/**` glob when no
 * file of the file map below it, of any project, counts or loads; a file that
 * loads, or a file that is no module and names a dependency, keeps its
 * folders out of a glob.
 */
function unloadedGlobs(
  graph: ProjectGraph,
  fileMap: ProjectFileMap,
  app: ProjectGraphProjectNode,
  counted: (node: ProjectGraphProjectNode) => FileData[],
  reached: ReadonlySet<string>,
): string[] {
  const walked = [...reachableProjects(graph, app, () => true).values()].filter(
    ({ name }) => name !== app.name,
  );
  const unloadable = new Set<string>();
  for (const { name } of walked) {
    for (const { file, deps } of fileMap[name] ?? []) {
      if (!reached.has(file) && (SCRIPT.test(file) || !deps?.length)) {
        unloadable.add(file);
      }
    }
  }
  const blocked = new Set<string>();
  for (const files of Object.values(fileMap)) {
    for (const { file } of files) {
      if (unloadable.has(file)) continue;
      for (
        let folder = posix.dirname(file);
        folder !== '.';
        folder = posix.dirname(folder)
      ) {
        blocked.add(folder);
      }
    }
  }
  const globs = new Set<string>();
  for (const node of walked) {
    for (const { file } of counted(node)) {
      if (reached.has(file) || !SCRIPT.test(file)) continue;
      let top: string | undefined;
      for (
        let folder = posix.dirname(file);
        folder !== '.' && !blocked.has(folder);
        folder = posix.dirname(folder)
      ) {
        top = folder;
      }
      globs.add(
        top === undefined ? literalGlob(file) : `${literalGlob(top)}/**`,
      );
    }
  }
  return [...globs].toSorted();
}
