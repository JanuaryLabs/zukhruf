import { z } from 'zod';

import {
  type DatasetRepository,
  type HubOptions,
  datasetRepository,
  metadataConfigs,
  readCardData,
} from '../dependencies/datasets.ts';
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
// name the data files of each split. It reads JSON Lines files only. The files
// come from the repository of dependencies/datasets.ts: a folder on disk, or
// the Hub with a cache folder.

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
  readonly #repository: DatasetRepository;

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
    this.#repository = datasetRepository({
      ...options,
      path: options.hfRepo,
    });
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
    const configs = metadataConfigs(
      readCardData(await this.#file('README.md')),
    );
    if (configs.length === 0)
      throw new Error(
        `${this.hfRepo}: the dataset card names no configs, and this port does not infer data files.`,
      );
    return new Map(
      configs.map(({ name, dataFiles }) => {
        if (dataFiles === null)
          throw new Error(
            `${this.hfRepo}: the config ${name} names no data files, and this port does not infer data files.`,
          );
        return [name, { splits: dataFiles }];
      }),
    );
  }

  async #file(path: string): Promise<string> {
    return new TextDecoder().decode(await this.#repository.read(path));
  }
}
