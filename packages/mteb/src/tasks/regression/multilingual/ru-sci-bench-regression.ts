import { AbsTaskRegression } from '../../../abstasks/regression.ts';
import { TaskMetadata } from '../../../abstasks/task-metadata.ts';
import type { HubOptions } from '../../../dependencies/datasets.ts';

// mteb/tasks/regression/multilingual/ru_sci_bench_regression.py.

const BIBTEX_CITATION = String.raw`
@article{vatolin2024ruscibench,
  author = {Vatolin, A. and Gerasimenko, N. and Ianina, A. and Vorontsov, K.},
  doi = {10.1134/S1064562424602191},
  issn = {1531-8362},
  journal = {Doklady Mathematics},
  month = {12},
  number = {1},
  pages = {S251--S260},
  title = {RuSciBench: Open Benchmark for Russian and English Scientific Document Representations},
  url = {https://doi.org/10.1134/S1064562424602191},
  volume = {110},
  year = {2024},
}
`;

export class RuSciBenchCitedCountRegression extends AbsTaskRegression {
  constructor(options: { readonly hub?: HubOptions } = {}) {
    super({
      ...options,
      metadata: new TaskMetadata({
        name: 'RuSciBenchCitedCountRegression',
        description:
          "Predicts the number of times a scientific article has been cited by other papers. The prediction is based on the article's title and abstract. The data is sourced from the Russian electronic library of scientific publications (eLibrary.ru) and includes papers with both Russian and English abstracts.",
        reference: 'https://github.com/mlsa-iai-msu-lab/ru_sci_bench_mteb',
        dataset: {
          path: 'mlsa-iai-msu-lab/ru_sci_bench_mteb',
          revision: 'fbc0599a0b5f00b3c7d87ab4d13490f04fb77f8e',
        },
        type: 'Regression',
        category: 't2c',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: new Map([
          ['cited_count_ru', ['rus-Cyrl']],
          ['cited_count_en', ['eng-Latn']],
        ]),
        mainScore: 'kendalltau',
        date: ['2007-01-01', '2023-01-01'],
        domains: ['Academic', 'Non-fiction', 'Written'],
        taskSubtypes: [],
        license: 'mit',
        sampleCreation: 'found',
        annotationsCreators: 'derived',
        dialect: [],
        bibtexCitation: BIBTEX_CITATION,
        prompt:
          'Predict the number of citations for a scientific article based on the title and abstract',
      }),
    });
  }
}

export class RuSciBenchYearPublRegression extends AbsTaskRegression {
  constructor(options: { readonly hub?: HubOptions } = {}) {
    super({
      ...options,
      metadata: new TaskMetadata({
        name: 'RuSciBenchYearPublRegression',
        description:
          "Predicts the publication year of a scientific article. The prediction is based on the article's title and abstract. The data is sourced from the Russian electronic library of scientific publications (eLibrary.ru) and includes papers with both Russian and English abstracts.",
        reference: 'https://github.com/mlsa-iai-msu-lab/ru_sci_bench_mteb',
        dataset: {
          path: 'mlsa-iai-msu-lab/ru_sci_bench_mteb',
          revision: 'fbc0599a0b5f00b3c7d87ab4d13490f04fb77f8e',
        },
        type: 'Regression',
        category: 't2c',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: new Map([
          ['yearpubl_ru', ['rus-Cyrl']],
          ['yearpubl_en', ['eng-Latn']],
        ]),
        mainScore: 'kendalltau',
        date: ['2007-01-01', '2023-01-01'],
        domains: ['Academic', 'Non-fiction', 'Written'],
        taskSubtypes: [],
        license: 'mit',
        sampleCreation: 'found',
        annotationsCreators: 'derived',
        dialect: [],
        bibtexCitation: BIBTEX_CITATION,
        prompt:
          'Predict paper publitaction year based on the title and abstract',
      }),
    });
  }
}
