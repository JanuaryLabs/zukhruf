import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import type {
  CorpusRow,
  QueryRow,
  RelevantDocumentsType,
  TopRankedDocumentsType,
} from '../types/encoder-io.ts';
import type { RetrievalSplitData } from './retrieval.ts';

// mteb/abstasks/retrieval_dataset_loaders.py. MTEB loads each config of a
// dataset with the HuggingFace datasets library. This port reads the dataset
// card (README.md) of the repository at its revision: the configs of the card
// name the data files of each split. It reads JSON Lines files only, and keeps
// each downloaded file in a cache folder. A repository that is a folder on disk
// is read from that folder, as load_dataset reads a local path.

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

// The configs of a dataset card. data_files is one path (the "train" split)
// or a path or paths for each split.
const cardSchema = z.object({
  configs: z
    .array(
      z.object({
        config_name: z.string(),
        data_files: z.union([
          z.string(),
          z.array(
            z.object({
              split: z.string(),
              path: z.union([z.string(), z.array(z.string())]),
            }),
          ),
        ]),
      }),
    )
    .default([]),
});

type Config = { readonly splits: ReadonlyMap<string, readonly string[]> };

const idSchema = z.union([z.string(), z.number()]).transform(String);

const corpusRowSchema = z
  .looseObject({
    _id: idSchema.optional(),
    id: idSchema.optional(),
    text: z.string(),
    title: z.string().optional(),
  })
  .transform(({ _id, id, title, ...row }) => ({
    ...row,
    ...(title === undefined ? {} : { title }),
    id: _id ?? id ?? '',
  }));

const queryRowSchema = z
  .looseObject({
    _id: idSchema.optional(),
    id: idSchema.optional(),
    text: z.union([
      z.string(),
      z.array(z.object({ role: z.string(), content: z.string() })),
    ]),
  })
  .transform(({ _id, id, ...row }) => ({ ...row, id: _id ?? id ?? '' }));

// datasets reads a score with the type of the dataset card (float64), also
// when the file holds it as a string, as mteb/arguana does; MTEB then casts it
// to int32, which a fraction does not survive.
const qrelSchema = z.object({
  'query-id': idSchema,
  'corpus-id': idSchema,
  score: z
    .union([z.number(), z.string().regex(/^\s*-?\d+(?:\.\d+)?\s*$/u)])
    .transform(Number)
    .pipe(z.number().int()),
});

const topRankedSchema = z.object({
  'query-id': idSchema,
  'corpus-ids': z.array(idSchema),
});

const instructionSchema = z.object({
  'query-id': idSchema,
  instruction: z.string(),
});

// The corpus, queries, qrels and candidates of one split of a retrieval
// dataset on the HuggingFace Hub or in a folder on disk.
export class RetrievalDatasetLoader {
  readonly hfRepo: string;
  readonly revision: string;
  readonly split: string;
  readonly config: string | null;
  readonly #endpoint: string;
  readonly #cacheFolder: string;
  // The repository is a folder on disk, which load_dataset reads in place
  // (datasets/load.py: os.path.isdir(path)): no revision, no cache.
  readonly #folder: boolean;

  constructor(
    options: HubOptions & {
      readonly hfRepo: string;
      readonly revision: string;
      readonly split?: string;
      readonly config?: string | null;
    },
  ) {
    this.hfRepo = options.hfRepo;
    this.revision = options.revision;
    this.split = options.split ?? 'test';
    this.config =
      options.config === 'default' ? null : (options.config ?? null);
    this.#endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.#cacheFolder = options.cacheFolder ?? DEFAULT_DATASET_CACHE;
    this.#folder =
      statSync(options.hfRepo, { throwIfNoEntry: false })?.isDirectory() ===
      true;
  }

  async load(): Promise<RetrievalSplitData> {
    const configs = await this.#configs();
    const relevantDocs = await this.#loadQrels(configs);
    const corpus = (await this.#rows(configs, this.#name('corpus'))).map(
      (row): CorpusRow => corpusRowSchema.parse(row),
    );
    let queries = (await this.#rows(configs, this.#queriesConfig(configs))).map(
      (row): QueryRow => queryRowSchema.parse(row),
    );
    queries = queries.filter((query) => relevantDocs.has(query.id));
    const topRankedConfig = this.#name('top_ranked');
    const topRanked: TopRankedDocumentsType | null = configs.has(
      topRankedConfig,
    )
      ? new Map(
          (await this.#rows(configs, topRankedConfig)).map((row) => {
            const parsed = topRankedSchema.parse(row);
            return [parsed['query-id'], parsed['corpus-ids']];
          }),
        )
      : null;
    const instructionConfig = this.#name('instruction');
    if (configs.has(instructionConfig)) {
      const instructions = new Map(
        (await this.#rows(configs, instructionConfig)).map((row) => {
          const parsed = instructionSchema.parse(row);
          return [parsed['query-id'], parsed.instruction];
        }),
      );
      queries = queries.map((query) => {
        const instruction = instructions.get(query.id);
        if (instruction === undefined)
          throw new Error(`KeyError: '${query.id}'`);
        return { ...query, instruction };
      });
    }
    return { corpus, queries, relevantDocs, topRanked };
  }

  #name(subset: string): string {
    return this.config === null ? subset : `${this.config}-${subset}`;
  }

  #queriesConfig(configs: ReadonlyMap<string, Config>): string {
    return configs.has('query') ? 'query' : this.#name('queries');
  }

  // The qrels of each query, in the order of the file.
  async #loadQrels(
    configs: ReadonlyMap<string, Config>,
  ): Promise<RelevantDocumentsType> {
    let config = this.config === null ? 'default' : `${this.config}-qrels`;
    if (config === 'default' && !configs.has(config)) {
      if (!configs.has('qrels'))
        throw new Error(
          'No qrels or default config found. Please specify a valid config or ensure the dataset has qrels.',
        );
      config = 'qrels';
    }
    const qrels = new Map<string, Map<string, number>>();
    for (const row of await this.#rows(configs, config)) {
      const parsed = qrelSchema.parse(row);
      const documents = qrels.get(parsed['query-id']) ?? new Map();
      documents.set(parsed['corpus-id'], parsed.score);
      qrels.set(parsed['query-id'], documents);
    }
    return qrels;
  }

  // The split of a config: the split of the loader, or the only one.
  #splitOf(name: string, config: Config): string {
    if (config.splits.has(this.split)) return this.split;
    const splits = [...config.splits.keys()];
    if (splits.length === 1 && splits[0] !== undefined) return splits[0];
    throw new Error(
      `Split ${this.split} not found in ${JSON.stringify(splits)}. Please specify a valid split.`,
    );
  }

  async #rows(
    configs: ReadonlyMap<string, Config>,
    name: string,
  ): Promise<unknown[]> {
    const config = configs.get(name);
    if (config === undefined)
      throw new Error(
        `BuilderConfig '${name}' not found. Available: ${JSON.stringify([...configs.keys()])}`,
      );
    const rows: unknown[] = [];
    for (const path of config.splits.get(this.#splitOf(name, config)) ?? []) {
      if (!path.endsWith('.jsonl'))
        throw new Error(
          `${this.hfRepo}: ${path} is not a JSON Lines file, and this port reads only JSON Lines.`,
        );
      for (const line of (await this.#file(path)).split('\n'))
        if (line.trim() !== '') rows.push(JSON.parse(line));
    }
    return rows;
  }

  // The configs of the dataset card (get_dataset_config_names).
  async #configs(): Promise<Map<string, Config>> {
    const text = await this.#file('README.md');
    const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? '';
    const card = cardSchema.parse(parse(frontMatter) ?? {});
    if (card.configs.length === 0)
      throw new Error(
        `${this.hfRepo}: the dataset card names no configs, and this port does not infer data files.`,
      );
    return new Map(
      card.configs.map(({ config_name, data_files }) => [
        config_name,
        {
          splits: new Map(
            typeof data_files === 'string'
              ? [['train', [data_files]]]
              : data_files.map(({ split, path }) => [
                  split,
                  typeof path === 'string' ? [path] : path,
                ]),
          ),
        },
      ]),
    );
  }

  // A file of the repository: from its folder on disk, or at the revision,
  // from the cache or the Hub.
  async #file(path: string): Promise<string> {
    if (this.#folder) return readFileSync(join(this.hfRepo, path), 'utf8');
    const cached = join(this.#cacheFolder, this.hfRepo, this.revision, path);
    if (existsSync(cached)) return readFileSync(cached, 'utf8');
    const url = `${this.#endpoint}/datasets/${this.hfRepo}/resolve/${this.revision}/${path}`;
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`${url}: ${response.status} ${response.statusText}`);
    const text = await response.text();
    mkdirSync(dirname(cached), { recursive: true });
    const partial = `${cached}.${process.pid}.partial`;
    writeFileSync(partial, text);
    renameSync(partial, cached);
    return text;
  }
}
