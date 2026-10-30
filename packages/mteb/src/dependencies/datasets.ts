import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { parquetMetadata, parquetReadObjects, parquetSchema } from 'hyparquet';
import { parse } from 'yaml';
import { z } from 'zod';

// The part of the HuggingFace datasets library (version 5.1.0) that
// load_dataset uses to read a dataset of JSON or parquet files: the configs of
// the dataset card (datasets/utils/metadata.py), the data files that it infers
// when the card has no configs (datasets/data_files.py), the builder that each
// file extension picks (datasets/load.py), and the json and parquet builders
// (datasets/packaged_modules/{json,parquet}). A repository is a folder on
// disk or a dataset repository of the HuggingFace Hub at a revision.
// Other file formats, archives other than gzip, scripts, streaming and the
// split verification of the card are not ported: they throw.

// A value of a row: what Dataset.to_list gives in Python.
export type DatasetValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | readonly DatasetValue[]
  | { readonly [key: string]: DatasetValue };

export type DatasetRow = Readonly<Record<string, DatasetValue>>;

// One split: its column names (the features of Python) and its rows.
export type Dataset = {
  readonly columnNames: readonly string[];
  readonly rows: readonly DatasetRow[];
};

// The splits of one config, in the order of its data files.
export type DatasetDict = ReadonlyMap<string, Dataset>;

// Where the files of the HuggingFace Hub come from and where they stay.
export type HubOptions = {
  // The origin of the Hub, as the HF_ENDPOINT variable of huggingface_hub.
  readonly endpoint?: string;
  // The folder of the downloaded files: <folder>/<repository>/<revision>/<path>.
  readonly cacheFolder?: string;
};

const DEFAULT_ENDPOINT = 'https://huggingface.co';

export const DEFAULT_DATASET_CACHE = join(
  homedir(),
  '.cache',
  'mteb',
  'datasets',
);

// The files of a dataset: a folder on disk or a repository of the Hub.
export type DatasetRepository = {
  readonly path: string;
  // The paths of all files, relative to the root and sorted, as fsspec's find
  // gives them.
  files(): Promise<readonly string[]>;
  read(path: string): Promise<Uint8Array>;
};

// load_dataset reads a path that is a folder on disk in place
// (datasets/load.py:1061, os.path.isdir): no revision, no cache.
export function datasetRepository(
  options: HubOptions & { readonly path: string; readonly revision: string },
): DatasetRepository {
  return statSync(options.path, { throwIfNoEntry: false })?.isDirectory() ===
    true
    ? new FolderRepository(options.path)
    : new HubRepository(options);
}

class FolderRepository implements DatasetRepository {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async files(): Promise<readonly string[]> {
    const files: string[] = [];
    for (const entry of readdirSync(this.path, {
      recursive: true,
      withFileTypes: true,
    })) {
      const full = join(entry.parentPath, entry.name);
      // A link counts when it points to a file (data_files.py:426).
      if (
        entry.isFile() ||
        (entry.isSymbolicLink() &&
          statSync(full, { throwIfNoEntry: false })?.isFile() === true)
      )
        files.push(
          full
            .slice(this.path.length + 1)
            .split('\\')
            .join('/'),
        );
    }
    return files.sort(byCodePoint);
  }

  async read(path: string): Promise<Uint8Array> {
    return readFileSync(join(this.path, path));
  }
}

class HubRepository implements DatasetRepository {
  readonly path: string;
  readonly #revision: string;
  readonly #endpoint: string;
  readonly #cacheFolder: string;

  constructor(
    options: HubOptions & { readonly path: string; readonly revision: string },
  ) {
    this.path = options.path;
    this.#revision = options.revision;
    this.#endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.#cacheFolder = options.cacheFolder ?? DEFAULT_DATASET_CACHE;
  }

  // HfFileSystem.find lists the tree of the repository at the revision
  // (huggingface_hub hf_api.py:4023, list_repo_tree with recursive=True,
  // expand=False), page by page through the Link header (utils/_pagination.py).
  async files(): Promise<readonly string[]> {
    const cached = join(
      this.#cacheFolder,
      this.path,
      `${this.#revision}.files.json`,
    );
    if (existsSync(cached))
      return z
        .array(z.string())
        .parse(JSON.parse(readFileSync(cached, 'utf8')));
    const files: string[] = [];
    let url: string | null =
      `${this.#endpoint}/api/datasets/${this.path}/tree/${encodeURIComponent(this.#revision)}?recursive=true&expand=false`;
    while (url !== null) {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
      for (const entry of treeSchema.parse(await response.json()))
        if (entry.type === 'file') files.push(entry.path);
      url = nextPage(response.headers.get('link'));
    }
    files.sort(byCodePoint);
    keep(cached, JSON.stringify(files));
    return files;
  }

  // A file at the revision, from the cache or the Hub.
  async read(path: string): Promise<Uint8Array> {
    const cached = join(this.#cacheFolder, this.path, this.#revision, path);
    if (existsSync(cached)) return readFileSync(cached);
    const url = `${this.#endpoint}/datasets/${this.path}/resolve/${encodeURIComponent(this.#revision)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`${url}: ${response.status} ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    keep(cached, bytes);
    return bytes;
  }
}

const treeSchema = z.array(
  z.looseObject({ type: z.string(), path: z.string() }),
);

function nextPage(link: string | null): string | null {
  return /<([^>]+)>;\s*rel="next"/u.exec(link ?? '')?.[1] ?? null;
}

// Writes a file of the cache in one step, so that a reader never sees part
// of it.
function keep(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, data);
  renameSync(partial, path);
}

// Python sorts strings by code point; JavaScript's default sort compares
// UTF-16 code units, which puts characters above U+FFFF before U+E000-U+FFFF.
function byCodePoint(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference =
      (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

// The YAML metadata of a dataset card (DatasetCard.load).
export function readCardData(text: string): Record<string, unknown> {
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? '';
  return z.record(z.string(), z.unknown()).parse(parse(frontMatter) ?? {});
}

// datasets/naming.py:29.
const SPLIT_RE = /^\w+(\.\w+)*$/u;

const dataFilesSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.array(
    z.object({
      split: z.string().regex(SPLIT_RE),
      path: z.union([z.string(), z.array(z.string())]),
    }),
  ),
]);

const configSchema = z.looseObject({
  config_name: z.string(),
  data_files: dataFilesSchema.optional(),
  data_dir: z.string().optional(),
  default: z.boolean().optional(),
  field: z.string().optional(),
  features: z.array(z.unknown()).optional(),
});

// One config of a dataset card: the patterns of the data files of each split,
// or none when the files are inferred, and the parameters of the builder.
export type MetadataConfig = {
  readonly name: string;
  readonly dataFiles: ReadonlyMap<string, readonly string[]> | null;
  readonly dataDir: string | null;
  readonly isDefault: boolean;
  readonly field: string | null;
  readonly features: readonly unknown[] | null;
};

// MetadataConfigs.from_dataset_card_data (utils/metadata.py:142): the configs
// of the card, in their order.
export function metadataConfigs(
  cardData: Record<string, unknown>,
): MetadataConfig[] {
  const configs = cardData.configs;
  if (configs === undefined || configs === null) return [];
  return z
    .array(configSchema)
    .parse(configs)
    .map((config) => ({
      name: config.config_name,
      dataFiles:
        config.data_files === undefined
          ? null
          : sanitizePatterns(config.data_files),
      dataDir: config.data_dir ?? null,
      isDefault: config.default === true,
      field: config.field ?? null,
      features: config.features ?? null,
    }));
}

// data_files.py:139: the patterns of each split. One path or a list of paths
// is the train split.
function sanitizePatterns(
  patterns: z.infer<typeof dataFilesSchema>,
): Map<string, readonly string[]> {
  if (typeof patterns === 'string') return new Map([['train', [patterns]]]);
  if (isPathList(patterns)) return new Map([['train', patterns]]);
  const splits = new Map<string, readonly string[]>();
  for (const pattern of patterns) {
    if (splits.has(pattern.split))
      throw new Error(
        `Some splits are duplicated in data_files: ${JSON.stringify(patterns.map((item) => item.split))}`,
      );
    splits.set(
      pattern.split,
      typeof pattern.path === 'string' ? [pattern.path] : pattern.path,
    );
  }
  return splits;
}

function isPathList(
  patterns: z.infer<typeof dataFilesSchema>,
): patterns is string[] {
  return (
    Array.isArray(patterns) &&
    patterns.every((item) => typeof item === 'string')
  );
}

// MetadataConfigs.get_default_config_name (utils/metadata.py:179).
function defaultConfigName(configs: readonly MetadataConfig[]): string | null {
  let name: string | null = null;
  for (const config of configs)
    if (configs.length === 1 || config.name === 'default' || config.isDefault) {
      if (name !== null)
        throw new Error(
          `Dataset has several default configs: '${name}' and '${config.name}'.`,
        );
      name = config.name;
    }
  return name;
}

// DatasetInfosDict.from_dataset_card_data (info.py:387): the features of the
// card, by config name.
function cardFeatures(
  cardData: Record<string, unknown>,
): Map<string, readonly unknown[] | null> {
  const info = z.looseObject({
    config_name: z.string().optional(),
    features: z.array(z.unknown()).optional(),
  });
  const infos = z
    .union([info, z.array(info)])
    .optional()
    .catch(undefined)
    .parse(cardData.dataset_info);
  if (infos === undefined) return new Map();
  return new Map(
    (Array.isArray(infos) ? infos : [infos]).map((item) => [
      item.config_name ?? 'default',
      item.features ?? null,
    ]),
  );
}

// data_files.py:41-117, for fsspec 2023.12.0 or later.
const SPLIT_PATTERN_SHARDED =
  'data/{split}-[0-9][0-9][0-9][0-9][0-9]-of-[0-9][0-9][0-9][0-9][0-9]*.*';
const DEFAULT_SPLITS = ['train', 'validation', 'test'] as const;
const SPLIT_KEYWORDS: Record<(typeof DEFAULT_SPLITS)[number], string[]> = {
  train: ['train', 'training'],
  validation: ['validation', 'valid', 'dev', 'val'],
  test: ['test', 'testing', 'eval', 'evaluation'],
};
const NON_WORDS_CHARS = '-._ 0-9';
const KEYWORDS_IN_FILENAME_BASE_PATTERNS = [
  '**/{keyword}[{sep}]*',
  '**/*[{sep}]{keyword}[{sep}]*',
];
const KEYWORDS_IN_DIR_NAME_BASE_PATTERNS = [
  '**/{keyword}/**',
  '**/{keyword}[{sep}]*/**',
  '**/*[{sep}]{keyword}/**',
  '**/*[{sep}]{keyword}[{sep}]*/**',
];

function keywordPatterns(
  basePatterns: readonly string[],
): Map<string, string[]> {
  return new Map(
    DEFAULT_SPLITS.map((split) => [
      split,
      SPLIT_KEYWORDS[split].flatMap((keyword) =>
        basePatterns.map((pattern) =>
          pattern
            .replaceAll('{keyword}', keyword)
            .replaceAll('{sep}', NON_WORDS_CHARS),
        ),
      ),
    ]),
  );
}

const ALL_DEFAULT_PATTERNS: readonly ReadonlyMap<string, readonly string[]>[] =
  [
    new Map([['logs', ['**/*.eval']]]),
    new Map([['test', ['**/task.toml', '**/instruction.md']]]),
    keywordPatterns(KEYWORDS_IN_DIR_NAME_BASE_PATTERNS),
    keywordPatterns(KEYWORDS_IN_FILENAME_BASE_PATTERNS),
    new Map([['train', ['**']]]),
  ];

const FILES_TO_IGNORE = [
  'README.md',
  'config.json',
  'dataset_info.json',
  'dataset_infos.json',
  'dummy_data.zip',
  'dataset_dict.json',
];

// _ALL_ALLOWED_EXTENSIONS of datasets/packaged_modules/__init__.py:185: the
// extensions of every builder, of archives and of metadata files.
const ALLOWED_EXTENSIONS = new Set(
  `.csv .tsv .json .jsonl .ndjson .parquet .geoparquet .gpq .arrow .txt .conll .conllu .tar .xml .hdf5 .h5 .eval .toml .md .lance .tsfile .vortex .fa .fasta .fna .ffn .faa .frn .afa .gb .gbk .genbank .fq .fastq .pdb .ent .cif .mmcif .PDB .ENT .blp .bmp .dib .bufr .cur .pcx .dcx .dds .ps .eps .fit .fits .fli .flc .ftc .ftu .gbr .gif .grib .png .apng .jp2 .j2k .jpc .jpf .jpx .j2c .icns .ico .im .iim .tif .tiff .jfif .jpe .jpg .jpeg .mpg .mpeg .msp .pcd .pxr .pbm .pgm .ppm .pnm .psd .bw .rgb .rgba .sgi .ras .tga .icb .vda .vst .webp .wmf .emf .xbm .xpm .BLP .BMP .DIB .BUFR .CUR .PCX .DCX .DDS .PS .EPS .FIT .FITS .FLI .FLC .FTC .FTU .GBR .GIF .GRIB .PNG .APNG .JP2 .J2K .JPC .JPF .JPX .J2C .ICNS .ICO .IM .IIM .TIF .TIFF .JFIF .JPE .JPG .JPEG .MPG .MPEG .MSP .PCD .PXR .PBM .PGM .PPM .PNM .PSD .BW .RGB .RGBA .SGI .RAS .TGA .ICB .VDA .VST .WEBP .WMF .EMF .XBM .XPM .aiff .au .avr .caf .flac .htk .svx .mat4 .mat5 .mpc2k .ogg .paf .pvf .raw .rf64 .sd2 .sds .ircam .voc .w64 .wav .nist .wavex .wve .xi .mp3 .opus .3gp .3g2 .avi .asf .flv .mp4 .mov .m4v .mkv .webm .f4v .wmv .wma .ogm .mxf .nut .AIFF .AU .AVR .CAF .FLAC .HTK .SVX .MAT4 .MAT5 .MPC2K .OGG .PAF .PVF .RAW .RF64 .SD2 .SDS .IRCAM .VOC .W64 .WAV .NIST .WAVEX .WVE .XI .MP3 .OPUS .3GP .3G2 .AVI .ASF .FLV .MP4 .MOV .M4V .MKV .WEBM .F4V .WMV .WMA .OGM .MXF .NUT .glb .ply .stl .GLB .PLY .STL .pdf .PDF .nii .NII .zip .idx .manifest .txn`.split(
    ' ',
  ),
);

// The extensions that pick a builder (_EXTENSION_TO_MODULE): the allowed
// extensions but archives and the metadata files of lance.
const BUILDER_EXTENSIONS = new Set(
  [...ALLOWED_EXTENSIONS].filter(
    (extension) => !['.zip', '.idx', '.manifest', '.txn'].includes(extension),
  ),
);

// _ALL_METADATA_FILENAMES of packaged_modules/__init__.py:186.
const METADATA_FILENAMES = new Set([
  'instruction.md',
  'latest_version_hint.json',
  'metadata.csv',
  'metadata.jsonl',
  'metadata.parquet',
  'task.toml',
]);

// The builders that this port has, with their extensions (_MODULE_TO_EXTENSIONS).
const MODULE_EXTENSIONS = {
  json: ['.json', '.jsonl', '.ndjson', '.zip'],
  parquet: ['.parquet', '.geoparquet', '.gpq', '.zip'],
} as const;

type Module = keyof typeof MODULE_EXTENSIONS;

// The builder of an extension, or the extension when this port has no
// builder for it.
function moduleOf(extension: string): Module | string {
  const modules: readonly Module[] = ['json', 'parquet'];
  for (const module of modules) {
    const extensions: readonly string[] = MODULE_EXTENSIONS[module];
    if (extension !== '.zip' && extensions.includes(extension)) return module;
  }
  return extension;
}

class FileNotFoundError extends Error {}

// glob.has_magic.
function hasMagic(pattern: string): boolean {
  return /[*?[]/u.test(pattern);
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// fsspec.utils.glob_translate (fsspec 2026.7.0 utils.py:722) and _translate
// (utils.py:648), copied from CPython's glob.translate: recursive, hidden
// files included, "/" the only separator.
export function globTranslate(pattern: string): RegExp {
  const parts = pattern.split('/');
  const last = parts.length - 1;
  let regex = '';
  for (const [index, part] of parts.entries()) {
    if (part === '*') {
      regex += index < last ? '[^/]+/' : '[^/]+';
      continue;
    }
    if (part === '**') {
      regex += index < last ? '(?:.+/)?' : '.*';
      continue;
    }
    if (part.includes('**'))
      throw new Error(
        "Invalid pattern: '**' can only be an entire path component",
      );
    if (part !== '') regex += translatePart(part);
    if (index < last) regex += '/';
  }
  return new RegExp(`^(?:${regex})$`, 'su');
}

function translatePart(pattern: string): string {
  const star = '[^/]*';
  const results: string[] = [];
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i] ?? '';
    i++;
    if (c === '*') {
      if (results.at(-1) !== star) results.push(star);
    } else if (c === '?') results.push('[^/]');
    else if (c === '[') {
      let j = i;
      if (j < n && pattern[j] === '!') j++;
      if (j < n && pattern[j] === ']') j++;
      while (j < n && pattern[j] !== ']') j++;
      if (j >= n) results.push('\\[');
      else {
        let stuff: string;
        if (!pattern.slice(i, j).includes('-'))
          stuff = pattern.slice(i, j).replaceAll('\\', '\\\\');
        else {
          const chunks: string[] = [];
          let k = pattern[i] === '!' ? i + 2 : i + 1;
          for (;;) {
            k = pattern.indexOf('-', k);
            if (k < 0 || k >= j) break;
            chunks.push(pattern.slice(i, k));
            i = k + 1;
            k += 3;
          }
          const chunk = pattern.slice(i, j);
          if (chunk !== '') chunks.push(chunk);
          else chunks[chunks.length - 1] += '-';
          for (let m = chunks.length - 1; m > 0; m--) {
            const previous = chunks[m - 1] ?? '';
            const current = chunks[m] ?? '';
            if (previous.at(-1)! > current[0]!) {
              chunks[m - 1] = previous.slice(0, -1) + current.slice(1);
              chunks.splice(m, 1);
            }
          }
          stuff = chunks
            .map((s) => s.replaceAll('\\', '\\\\').replaceAll('-', '\\-'))
            .join('-');
        }
        stuff = stuff.replace(/([&~|])/gu, '\\$1');
        i = j + 1;
        if (stuff === '') results.push('(?!)');
        else if (stuff === '!') results.push('.');
        else {
          if (stuff[0] === '!') stuff = `^${stuff.slice(1)}`;
          else if (stuff[0] === '^' || stuff[0] === '[') stuff = `\\${stuff}`;
          // A JavaScript class with the u flag needs the escapes that Python
          // reads as plain characters.
          results.push(`[${stuff.replace(/(?<!\\)([[\]/{}()])/gu, '\\$1')}]`);
        }
      }
    } else results.push(escapeRegExp(c));
  }
  return results.join('');
}

// The parts of a path that start with a dot, as PurePath.parts gives them
// (data_files.py:253).
function hiddenParts(path: string): number {
  return path
    .split('/')
    .filter((part) => part.startsWith('.') && !/^\.+$/u.test(part)).length;
}

// The folders of a path that start with two underscores (data_files.py:193).
function specialFolders(path: string): number {
  return path
    .split('/')
    .slice(0, -1)
    .filter((part) => part.startsWith('__')).length;
}

// resolve_pattern (data_files.py:362): the files of the repository that a
// pattern names, relative to the folder base.
function resolvePattern(
  pattern: string,
  files: readonly string[],
  base: string,
  allowedExtensions: ReadonlySet<string> | null,
): string[] {
  if (/^[a-z][\w+.-]*:\/\//iu.test(pattern) || pattern.startsWith('/'))
    throw new Error(
      `${pattern}: this port reads the data files of the repository only.`,
    );
  const full = base === '' ? pattern : posix.join(base, pattern);
  const basename = posix.basename(full);
  const ignored = new Set(FILES_TO_IGNORE.filter((name) => name !== basename));
  const regex = globTranslate(full);
  const matched = (
    hasMagic(full)
      ? files.filter((file) => regex.test(file))
      : files.filter((file) => file === full)
  ).filter(
    (file) =>
      !ignored.has(posix.basename(file)) &&
      specialFolders(file) === specialFolders(full) &&
      hiddenParts(file) === hiddenParts(full),
  );
  const out =
    allowedExtensions === null
      ? matched
      : matched.filter((file) =>
          posix
            .basename(file)
            .split('.')
            .slice(1)
            .some((suffix) => allowedExtensions.has(`.${suffix}`)),
        );
  if (out.length === 0)
    throw new FileNotFoundError(
      `Unable to find '${full}'${allowedExtensions === null ? '' : ' with any supported extension'}`,
    );
  return out;
}

// DataFilesList.from_patterns (data_files.py:617): the files of each pattern,
// in the order of the patterns. A pattern with wildcards may match nothing.
function resolvePatterns(
  patterns: ReadonlyMap<string, readonly string[]>,
  files: readonly string[],
  base: string,
): Map<string, string[]> {
  return new Map(
    [...patterns].map(([split, splitPatterns]) => [
      split,
      splitPatterns.flatMap((pattern) => {
        try {
          return resolvePattern(pattern, files, base, ALLOWED_EXTENSIONS);
        } catch (error) {
          if (error instanceof FileNotFoundError && hasMagic(pattern))
            return [];
          throw error;
        }
      }),
    ]),
  );
}

// get_data_patterns (data_files.py:454): the patterns of the first layout that
// matches a file: sharded files in data/, then the default patterns.
function getDataPatterns(
  files: readonly string[],
  base: string,
): Map<string, readonly string[]> {
  const matches = (pattern: string): boolean => {
    try {
      return resolvePattern(pattern, files, base, null).length > 0;
    } catch (error) {
      if (error instanceof FileNotFoundError) return false;
      throw error;
    }
  };
  const sharded = SPLIT_PATTERN_SHARDED.replace('{split}', '*');
  if (matches(sharded)) {
    const found = new Set<string>();
    // string_to_dict (utils/py_utils.py:158) reads the pattern as a regex.
    const regex = new RegExp(
      posix.basename(SPLIT_PATTERN_SHARDED).replace('{split}', '(?<split>.+)'),
      'u',
    );
    for (const file of resolvePattern(sharded, files, base, null)) {
      const split = regex.exec(posix.basename(file))?.groups?.split;
      if (split !== undefined) found.add(split);
    }
    if ([...found].some((split) => !SPLIT_RE.test(split)))
      throw new Error(
        `Split name should match '${SPLIT_RE.source}'' but got '${JSON.stringify([...found])}'.`,
      );
    const defaults: readonly string[] = DEFAULT_SPLITS;
    const sorted = [
      ...DEFAULT_SPLITS.filter((split) => found.has(split)),
      ...[...found]
        .filter((split) => !defaults.includes(split))
        .sort(byCodePoint),
    ];
    return new Map(
      sorted.map((split) => [
        split,
        [SPLIT_PATTERN_SHARDED.replace('{split}', split)],
      ]),
    );
  }
  for (const patterns of ALL_DEFAULT_PATTERNS) {
    const found = [...patterns].filter(([, splitPatterns]) =>
      splitPatterns.some(matches),
    );
    if (found.length > 0) return new Map(found);
  }
  throw new Error(
    `The directory at ${base === '' ? '.' : base} doesn't contain any data files`,
  );
}

// infer_module_for_data_files_list (load.py:202): the builder of the most
// common extension; on a draw parquet first, then the order of the sort key.
function inferModuleOfFiles(files: readonly string[]): Module | string | null {
  const counts = new Map<string, number>();
  for (const file of files) {
    const basename = posix.basename(file);
    const metadata = METADATA_FILENAMES.has(basename);
    for (const suffix of basename.split('.').slice(1)) {
      const key = `${metadata ? '1' : '0'}.${suffix.toLowerCase()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const favourites = [
    '.parquet',
    '.lance',
    '.vortex',
    '.arrow',
    '.jsonl',
    '.json',
    '.csv',
  ];
  const sortKey = ([key, count]: [string, number]) => {
    const extension = key.slice(1);
    return [
      key[0] === '0' ? 1 : 0,
      count,
      ...favourites.map((favourite) => (extension === favourite ? 1 : 0)),
    ];
  };
  const ordered = [...counts].sort((a, b) => {
    const left = sortKey(a);
    const right = sortKey(b);
    for (let i = 0; i < left.length; i++)
      if (left[i] !== right[i]) return (right[i] ?? 0) - (left[i] ?? 0);
    return byCodePoint(b[0].slice(1), a[0].slice(1));
  });
  for (const [key] of ordered) {
    const extension = key.slice(1);
    if (BUILDER_EXTENSIONS.has(extension)) return moduleOf(extension);
    if (extension === '.zip')
      throw new Error(
        'This port does not read data files in zip archives (infer_module_for_data_files_list_in_archives).',
      );
  }
  return null;
}

// infer_module_for_data_files (load.py:285): one builder for all splits.
function inferModule(
  dataFiles: ReadonlyMap<string, readonly string[]>,
  path: string,
): Module {
  const modules = [...dataFiles.values()].map(inferModuleOfFiles);
  const module = modules[0] ?? null;
  if (modules.some((other) => other !== module))
    throw new Error(
      `Couldn't infer the same data file format for all splits. Got ${JSON.stringify(Object.fromEntries([...dataFiles.keys()].map((split, index) => [split, modules[index]])))}`,
    );
  if (module === null)
    throw new Error(`No (supported) data files found in ${path}`);
  if (module !== 'json' && module !== 'parquet')
    throw new Error(
      `${path}: this port reads JSON and parquet data files, not ${module} files.`,
    );
  return module;
}

// A config that load_dataset builds: its data files and its parameters.
type BuilderConfig = {
  readonly name: string;
  readonly dataFiles: ReadonlyMap<string, readonly string[]>;
  readonly field: string | null;
  readonly features: readonly unknown[] | null;
};

// load_dataset(path, name=name) for a dataset of JSON or parquet files
// (load.py:1446): the splits of the config, each with its rows.
export async function loadDataset(
  options: HubOptions & {
    readonly path: string;
    readonly revision: string;
    readonly name?: string | null;
  },
): Promise<DatasetDict> {
  const repository = datasetRepository(options);
  const files = await repository.files();
  // LocalDatasetModuleFactory.get_module (load.py:422) and
  // HubDatasetModuleFactory.get_module (load.py:577).
  const cardData = files.includes('README.md')
    ? readCardData(new TextDecoder().decode(await repository.read('README.md')))
    : {};
  const configs = metadataConfigs(cardData);
  const infos = cardFeatures(cardData);
  const first = configs[0];
  const patterns =
    first?.dataFiles != null ? first.dataFiles : getDataPatterns(files, '');
  let dataFiles = resolvePatterns(patterns, files, '');
  const module = inferModule(dataFiles, options.path);
  // DataFilesDict.filter (data_files.py:640) keeps the files of the builder.
  const extensions = new RegExp(
    `^.*(${MODULE_EXTENSIONS[module].map(escapeRegExp).join('|')})(\\..+)?$`,
    'u',
  );
  dataFiles = new Map(
    [...dataFiles].map(([split, list]) => [
      split,
      list.filter((file) => extensions.test(file)),
    ]),
  );
  let builderConfigs: BuilderConfig[];
  let defaultName: string | null;
  if (configs.length > 0) {
    // create_builder_configs_from_metadata_configs (load.py:313).
    builderConfigs = configs.map((config) => {
      const base = config.dataDir ?? '';
      return {
        name: config.name,
        dataFiles: resolvePatterns(
          config.dataFiles ?? getDataPatterns(files, base),
          files,
          base,
        ),
        field: config.field,
        features: config.features,
      };
    });
    defaultName = defaultConfigName(configs);
  } else {
    builderConfigs = [
      { name: 'default', dataFiles, field: null, features: null },
    ];
    defaultName = null;
  }
  if (defaultName === null && infos.size === 1)
    defaultName = [...infos.keys()][0] ?? null;
  const config = chooseConfig(
    builderConfigs,
    options.name ?? null,
    defaultName,
  );
  const features = config.features ?? infos.get(config.name) ?? null;
  return await (module === 'json'
    ? readJsonSplits(repository, config, features)
    : readParquetSplits(repository, config, features));
}

// DatasetBuilder._create_builder_config (builder.py:520).
function chooseConfig(
  configs: readonly BuilderConfig[],
  name: string | null,
  defaultName: string | null,
): BuilderConfig {
  const names = JSON.stringify(configs.map((config) => config.name));
  const named = name ?? defaultName;
  if (named === null) {
    if (configs.length > 1)
      throw new Error(
        `Config name is missing.\nPlease pick one among the available configs: ${names}`,
      );
    const only = configs[0];
    if (only === undefined) throw new Error('The dataset has no config.');
    return only;
  }
  const config = configs.find((item) => item.name === named);
  if (config === undefined)
    throw new Error(`BuilderConfig '${named}' not found. Available: ${names}`);
  return config;
}

// The magic numbers of the archives that datasets extracts
// (utils/extract.py:139-384). Only gzip is ported.
const ARCHIVES: readonly (readonly [string, readonly number[]])[] = [
  ['zip', [0x50, 0x4b, 0x03, 0x04]],
  ['zip', [0x50, 0x4b, 0x05, 0x06]],
  ['zip', [0x50, 0x4b, 0x07, 0x08]],
  ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
  ['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
  ['zstd', [0x28, 0xb5, 0x2f, 0xfd]],
  ['bz2', [0x42, 0x5a, 0x68]],
  ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  ['lz4', [0x04, 0x22, 0x4d, 0x18]],
];

// DownloadManager.extract: a gzip file is read through gunzip, whatever its
// name.
function extract(bytes: Uint8Array, path: string): Uint8Array {
  const starts = (magic: readonly number[]) =>
    magic.every((byte, index) => bytes[index] === byte);
  if (starts([0x1f, 0x8b])) return gunzipSync(bytes);
  for (const [format, magic] of ARCHIVES)
    if (starts(magic))
      throw new Error(`${path}: this port does not extract ${format} files.`);
  return bytes;
}

const CHUNK_SIZE = 10 << 20;

// The JSON values of a stream of JSON texts, as pyarrow's JSON reader parses
// JSON Lines: each value with the byte offset where it starts.
function jsonStream(bytes: Uint8Array): { start: number; value: unknown }[] {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const values: { start: number; value: unknown }[] = [];
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i];
    if (byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09) {
      i++;
      continue;
    }
    const start = i;
    if (byte !== 0x7b)
      throw new Error(
        'This port reads JSON Lines files whose lines are JSON objects.',
      );
    let depth = 0;
    let inString = false;
    for (; i < bytes.length; i++) {
      const b = bytes[i];
      if (inString) {
        if (b === 0x5c) i++;
        else if (b === 0x22) inString = false;
      } else if (b === 0x22) inString = true;
      else if (b === 0x7b || b === 0x5b) depth++;
      else if (b === 0x7d || b === 0x5d) {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    values.push({
      start,
      value: JSON.parse(decoder.decode(bytes.subarray(start, i))),
    });
  }
  return values;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The rows of a JSON file, and how many of them pyarrow reads in its first
// chunk (Json._generate_tables, packaged_modules/json/json.py:236).
function jsonRows(
  bytes: Uint8Array,
  field: string | null,
  path: string,
): { rows: Record<string, unknown>[]; firstChunk: number } {
  // A leading UTF-8 byte order mark is dropped (json.py:283).
  const body =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;
  const text = () => new TextDecoder('utf-8', { fatal: true }).decode(body);
  if (field !== null) {
    // The file is one JSON object and the rows are in one field (json.py:183):
    // pandas.read_json reads the field.
    const document: unknown = JSON.parse(text());
    if (!isObject(document) || !(field in document))
      throw new Error(`KeyError: '${field}'`);
    const rows = pandasRows(document[field], path);
    return { rows, firstChunk: rows.length };
  }
  if (body[0] === 0x5b) {
    // A JSON array is converted to JSON Lines (json.py:292): objects, or
    // strings that become the "text" column.
    const head = body.subarray(0, 100);
    const quote = head.indexOf(0x22);
    const objects = (quote < 0 ? head : head.subarray(0, quote)).includes(0x7b);
    const items = z.array(z.unknown()).parse(JSON.parse(text()));
    const rows = items.map((item) => {
      const row = objects ? item : { text: item };
      if (!isObject(row))
        throw new Error(`${path}: an item of the array is not an object.`);
      return row;
    });
    return { rows, firstChunk: rows.length };
  }
  const values = jsonStream(body);
  // The first chunk is 10 MiB and the rest of its last line.
  const newline = body.indexOf(0x0a, CHUNK_SIZE);
  const chunkEnd =
    body.length <= CHUNK_SIZE
      ? body.length
      : newline < 0
        ? body.length
        : newline + 1;
  return {
    rows: values.map(({ value }) => {
      if (!isObject(value))
        throw new Error(`${path}: a line is not a JSON object.`);
      return value;
    }),
    firstChunk: values.filter(({ start }) => start < chunkEnd).length,
  };
}

// pandas.read_json of the rows in a field: a list of records, a list of
// values (the "text" column), or a dict of columns of equal length.
function pandasRows(data: unknown, path: string): Record<string, unknown>[] {
  if (Array.isArray(data))
    return data.map((item: unknown) =>
      isObject(item) ? item : { text: item },
    );
  const columns = z.record(z.string(), z.array(z.unknown())).safeParse(data);
  const lengths = new Set(
    Object.values(columns.data ?? {}).map((column) => column.length),
  );
  if (columns.success && lengths.size <= 1) {
    const entries = Object.entries(columns.data);
    return Array.from({ length: [...lengths][0] ?? 0 }, (_, index) =>
      Object.fromEntries(
        entries.map(([name, values]) => [name, values[index]]),
      ),
    );
  }
  throw new Error(
    `${path}: this port reads a field that holds a list of rows or a dict of columns.`,
  );
}

// The columns of the first rows, in the order in which each first appears.
function columnsOf(rows: readonly Record<string, unknown>[]): string[] {
  const columns = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) columns.add(key);
  return [...columns];
}

// The json builder (packaged_modules/json/json.py): the columns of the first
// chunk of the first file of the first split, or the features; each later
// table gets null for a column that it does not have (json.py:110), and a
// column that the features do not have cannot be cast.
async function readJsonSplits(
  repository: DatasetRepository,
  config: BuilderConfig,
  features: readonly unknown[] | null,
): Promise<DatasetDict> {
  const typed = features === null ? null : parseFeatures(features);
  let columns: readonly string[] | null =
    typed === null ? null : [...typed.keys()];
  const splits = new Map<string, Dataset>();
  for (const [split, files] of config.dataFiles) {
    const rows: DatasetRow[] = [];
    for (const file of files) {
      const read = jsonRows(
        extract(await repository.read(file), file),
        config.field,
        file,
      );
      columns ??= columnsOf(read.rows.slice(0, read.firstChunk));
      for (const row of read.rows)
        rows.push(castRow(row, columns, typed, file));
    }
    splits.set(split, { columnNames: columns ?? [], rows });
  }
  return splits;
}

// The parquet builder (packaged_modules/parquet/parquet.py): the features of
// the first file (parquet.py:121), and each table cast to them.
async function readParquetSplits(
  repository: DatasetRepository,
  config: BuilderConfig,
  features: readonly unknown[] | null,
): Promise<DatasetDict> {
  const typed = features === null ? null : parseFeatures(features);
  let columns: readonly string[] | null =
    typed === null ? null : [...typed.keys()];
  const splits = new Map<string, Dataset>();
  for (const [split, files] of config.dataFiles) {
    const rows: DatasetRow[] = [];
    for (const file of files) {
      const bytes = await repository.read(file);
      const buffer = new Uint8Array(bytes).buffer;
      const fileColumns = parquetSchema(parquetMetadata(buffer)).children.map(
        (child) => child.element.name,
      );
      columns ??= fileColumns;
      if (
        fileColumns.length !== columns.length ||
        fileColumns.some((column) => !columns?.includes(column))
      )
        throw castError(fileColumns, columns, file);
      // utf8: false reads a BYTE_ARRAY column without a string annotation as
      // bytes, as pyarrow does.
      for (const row of await parquetReadObjects({ file: buffer, utf8: false }))
        rows.push(castRow(row, columns, typed, file));
    }
    splits.set(split, { columnNames: columns ?? [], rows });
  }
  return splits;
}

function isList(value: DatasetValue): value is readonly DatasetValue[] {
  return Array.isArray(value);
}

// A value of JSON.parse or hyparquet as Python gets it from pyarrow: an
// int64 of parquet is a bigint in hyparquet and a number here.
function datasetValue(value: unknown, where: string): DatasetValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number))
      throw new RangeError(
        `${where}: ${value} is beyond the integers that a JavaScript number holds.`,
      );
    return number;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    value instanceof Uint8Array
  )
    return value;
  if (Array.isArray(value))
    return value.map((item: unknown) => datasetValue(item, where));
  if (Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        datasetValue(item, `${where}.${key}`),
      ]),
    );
  throw new Error(
    `${where}: this port does not read values of type ${Object.prototype.toString.call(value)}.`,
  );
}

function castError(
  have: readonly string[],
  want: readonly string[],
  file: string,
): Error {
  return new Error(
    `${file}: Couldn't cast the columns ${JSON.stringify(have)} to ${JSON.stringify(want)} because column names don't match`,
  );
}

// A row with the columns of the split, in their order: a column that the row
// does not have is null.
function castRow(
  row: Record<string, unknown>,
  columns: readonly string[],
  features: ReadonlyMap<string, Feature> | null,
  file: string,
): DatasetRow {
  for (const key of Object.keys(row))
    if (!columns.includes(key))
      throw castError(Object.keys(row), columns, file);
  return Object.fromEntries(
    columns.map((column) => {
      const value = datasetValue(row[column], `${file}: ${column}`);
      const feature = features?.get(column);
      return [
        column,
        feature === undefined
          ? value
          : castValue(value, feature, `${file}: ${column}`),
      ];
    }),
  );
}

// The features of a card that this port casts to (Features._from_yaml_list,
// features/features.py:2150): a Value of a number, string or boolean type,
// a ClassLabel, and a list of these.
type Feature =
  | { readonly kind: 'value'; readonly dtype: string }
  | { readonly kind: 'classLabel' }
  | { readonly kind: 'list'; readonly feature: Feature };

const VALUE_TYPES = new Set([
  'null',
  'bool',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'float32',
  'float64',
  'string',
  'large_string',
]);

function parseFeatures(features: readonly unknown[]): Map<string, Feature> {
  return new Map(
    features.map((item) => {
      const feature = z.looseObject({ name: z.string() }).parse(item);
      return [feature.name, parseFeature(feature, feature.name)];
    }),
  );
}

function parseFeature(item: Record<string, unknown>, name: string): Feature {
  for (const key of ['sequence', 'list', 'large_list']) {
    const inner = item[key];
    if (typeof inner === 'string')
      return { kind: 'list', feature: parseFeature({ dtype: inner }, name) };
    if (isObject(inner))
      return { kind: 'list', feature: parseFeature(inner, name) };
  }
  const dtype = item.dtype;
  if (typeof dtype === 'string' && VALUE_TYPES.has(dtype))
    return { kind: 'value', dtype };
  if (isObject(dtype) && isObject(dtype.class_label))
    return { kind: 'classLabel' };
  throw new Error(
    `The feature ${name} (${JSON.stringify(item)}) is not a feature that this port casts to.`,
  );
}

const INTEGER_STRING = /^-?\d+$/u;
const FLOAT_STRING = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/u;

// table_cast of a value to its feature (table.py), for the casts that pyarrow
// does without loss. Another cast throws.
function castValue(
  value: DatasetValue,
  feature: Feature,
  where: string,
): DatasetValue {
  if (value === null) return null;
  const fail = () =>
    new Error(
      `${where}: this port does not cast ${JSON.stringify(value)} to ${JSON.stringify(feature)}.`,
    );
  if (feature.kind === 'list') {
    if (!isList(value)) throw fail();
    return value.map((item) => castValue(item, feature.feature, where));
  }
  if (feature.kind === 'classLabel') {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    throw fail();
  }
  const { dtype } = feature;
  if (dtype === 'string' || dtype === 'large_string') {
    if (typeof value === 'string') return value;
    throw fail();
  }
  if (dtype === 'bool') {
    if (typeof value === 'boolean') return value;
    throw fail();
  }
  if (dtype.startsWith('int') || dtype.startsWith('uint')) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && INTEGER_STRING.test(value))
      return Number(value);
    throw fail();
  }
  if (dtype === 'float32' || dtype === 'float64') {
    const number =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && FLOAT_STRING.test(value)
          ? Number(value)
          : null;
    if (number === null) throw fail();
    return dtype === 'float32' ? Math.fround(number) : number;
  }
  throw fail();
}
