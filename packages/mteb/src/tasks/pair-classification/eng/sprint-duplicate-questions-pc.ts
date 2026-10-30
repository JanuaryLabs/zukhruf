import { AbsTaskPairClassification } from '../../../abstasks/pair-classification.ts';
import { TaskMetadata } from '../../../abstasks/task-metadata.ts';
import {
  type HubOptions,
  renameColumn,
} from '../../../dependencies/datasets.ts';

// mteb/tasks/pair_classification/eng/sprint_duplicate_questions_pc.py.
export class SprintDuplicateQuestionsPC extends AbsTaskPairClassification {
  constructor(options: { readonly hub?: HubOptions } = {}) {
    super({
      ...options,
      metadata: new TaskMetadata({
        name: 'SprintDuplicateQuestions',
        description: 'Duplicate questions from the Sprint community.',
        reference: 'https://www.aclweb.org/anthology/D18-1131/',
        dataset: {
          path: 'mteb/sprintduplicatequestions-pairclassification',
          revision: 'd66bd1f72af766a5cc4b0ca5e00c162f89e8cc46',
        },
        type: 'PairClassification',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'max_ap',
        // Not found in the paper or data. This is just a rough guess based
        // on the paper's publication date.
        date: ['2018-10-01', '2018-12-30'],
        domains: ['Programming', 'Written'],
        taskSubtypes: ['Duplicate Detection'],
        license: 'not specified',
        annotationsCreators: 'derived',
        dialect: [],
        sampleCreation: 'found',
        prompt: 'Retrieve duplicate questions from Sprint forum',
        bibtexCitation: String.raw`
@inproceedings{shah-etal-2018-adversarial,
  address = {Brussels, Belgium},
  author = {Shah, Darsh  and
Lei, Tao  and
Moschitti, Alessandro  and
Romeo, Salvatore  and
Nakov, Preslav},
  booktitle = {Proceedings of the 2018 Conference on Empirical Methods in Natural Language Processing},
  doi = {10.18653/v1/D18-1131},
  editor = {Riloff, Ellen  and
Chiang, David  and
Hockenmaier, Julia  and
Tsujii, Jun{'}ichi},
  month = oct # {-} # nov,
  pages = {1056--1063},
  publisher = {Association for Computational Linguistics},
  title = {Adversarial Domain Adaptation for Duplicate Question Detection},
  url = {https://aclanthology.org/D18-1131},
  year = {2018},
}
`,
      }),
    });
  }

  override datasetTransform(): void {
    for (const splits of this.dataset?.values() ?? [])
      for (const [split, data] of splits)
        splits.set(
          split,
          renameColumn(
            renameColumn(data, 'sent1', 'sentence1'),
            'sent2',
            'sentence2',
          ),
        );
  }
}
