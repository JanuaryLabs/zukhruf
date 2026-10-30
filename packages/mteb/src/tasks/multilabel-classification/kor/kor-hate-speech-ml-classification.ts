import { AbsTaskMultilabelClassification } from '../../../abstasks/multilabel-classification.ts';
import { TaskMetadata } from '../../../abstasks/task-metadata.ts';
import type { HubOptions } from '../../../dependencies/datasets.ts';

// mteb/tasks/multilabel_classification/kor/kor_hate_speech_ml_classification.py.

const BIBTEX_CITATION = String.raw`
@inproceedings{lee-etal-2022-k,
  address = {Gyeongju, Republic of Korea},
  archiveprefix = {arXiv},
  author = {Lee, Jean  and
Lim, Taejun  and
Lee, Heejun  and
Jo, Bogeun  and
Kim, Yangsok  and
Yoon, Heegeun  and
Han, Soyeon Caren},
  booktitle = {Proceedings of the 29th International Conference on Computational Linguistics},
  eprint = {2208.10684},
  month = oct,
  pages = {3530--3538},
  publisher = {International Committee on Computational Linguistics},
  title = {K-{MH}a{S}: A Multi-label Hate Speech Detection Dataset in {K}orean Online News Comment},
  url = {https://aclanthology.org/2022.coling-1.311},
  year = {2022},
}
`;

export class KorHateSpeechMLClassification extends AbsTaskMultilabelClassification {
  constructor(options: { readonly hub?: HubOptions } = {}) {
    super({
      ...options,
      metadata: new TaskMetadata({
        name: 'KorHateSpeechMLClassification',
        description:
          'The Korean Multi-label Hate Speech Dataset, K-MHaS, consists of 109,692 utterances from Korean online news comments, labelled with 8 fine-grained hate speech classes (labels: Politics, Origin, Physical, Age, Gender, Religion, Race, Profanity) or Not Hate Speech class. Each utterance provides from a single to four labels that can handles Korean language patterns effectively. For more details, please refer to the paper about K-MHaS, published at COLING 2022. This dataset is based on the Korean online news comments available on Kaggle and Github. The unlabeled raw data was collected between January 2018 and June 2020. The language producers are users who left the comments on the Korean online news platform between 2018 and 2020.',
        dataset: {
          path: 'mteb/KorHateSpeechMLClassification',
          revision: '47cd2e61b64f2f11ccb006a579cda71318c6de9b',
        },
        reference:
          'https://paperswithcode.com/dataset/korean-multi-label-hate-speech-dataset',
        type: 'MultilabelClassification',
        category: 't2c',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['kor-Hang'],
        mainScore: 'accuracy',
        date: ['2018-01-01', '2020-06-30'],
        domains: ['Social', 'Written'],
        taskSubtypes: ['Sentiment/Hate speech'],
        license: 'cc-by-sa-4.0',
        annotationsCreators: 'expert-annotated',
        dialect: [],
        sampleCreation: 'found',
        bibtexCitation: BIBTEX_CITATION,
      }),
    });
  }
}
