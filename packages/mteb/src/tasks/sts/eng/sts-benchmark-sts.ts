import { AbsTaskSTS } from '../../../abstasks/sts.ts';
import { TaskMetadata } from '../../../abstasks/task-metadata.ts';
import type { HubOptions } from '../../../dependencies/datasets.ts';

// mteb/tasks/sts/eng/sts_benchmark_sts.py, STSBenchmarkSTS.
export class STSBenchmarkSTS extends AbsTaskSTS {
  constructor(options: { readonly hub?: HubOptions } = {}) {
    super({
      ...options,
      metadata: new TaskMetadata({
        name: 'STSBenchmark',
        dataset: {
          path: 'mteb/stsbenchmark-sts',
          revision: 'b0fddb56ed78048fa8b90373c8a3cfc37b684831',
        },
        description:
          'Semantic Textual Similarity Benchmark (STSbenchmark) dataset.',
        reference: 'https://github.com/PhilipMay/stsb-multi-mt/',
        type: 'STS',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'cosine_spearman',
        // publication year
        date: ['2021-01-01', '2021-12-31'],
        domains: ['Blog', 'News', 'Written'],
        taskSubtypes: [],
        license: 'not specified',
        annotationsCreators: 'human-annotated',
        dialect: [],
        sampleCreation: 'machine-translated and verified',
        bibtexCitation: String.raw`
@inproceedings{cer-etal-2017-semeval,
  address = {Vancouver, Canada},
  author = {Cer, Daniel  and
Diab, Mona  and
Agirre, Eneko  and
Lopez-Gazpio, I{\~n}igo  and
Specia, Lucia},
  booktitle = {Proceedings of the 11th International Workshop on Semantic Evaluation ({S}em{E}val-2017)},
  doi = {10.18653/v1/S17-2001},
  editor = {Bethard, Steven  and
Carpuat, Marine  and
Apidianaki, Marianna  and
Mohammad, Saif M.  and
Cer, Daniel  and
Jurgens, David},
  month = aug,
  pages = {1--14},
  publisher = {Association for Computational Linguistics},
  title = {{S}em{E}val-2017 Task 1: Semantic Textual Similarity Multilingual and Crosslingual Focused Evaluation},
  url = {https://aclanthology.org/S17-2001},
  year = {2017},
}
`,
        supersededBy: 'STSBenchmark.v2',
      }),
    });
  }
}
