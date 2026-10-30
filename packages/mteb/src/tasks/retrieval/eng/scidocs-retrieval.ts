import type { HubOptions } from '../../../abstasks/retrieval-dataset-loaders.ts';
import { AbsTaskRetrieval } from '../../../abstasks/retrieval.ts';
import { TaskMetadata } from '../../../abstasks/task-metadata.ts';

// mteb/tasks/retrieval/eng/scidocs_retrieval.py.
export class SCIDOCS extends AbsTaskRetrieval {
  constructor(options: { readonly hub?: HubOptions } = {}) {
    super({
      ...options,
      metadata: new TaskMetadata({
        name: 'SCIDOCS',
        dataset: {
          path: 'mteb/scidocs',
          revision: 'f8c2fcf00f625baaa80f62ec5bd9e1fff3b8ae88',
        },
        description:
          'SciDocs, a new evaluation benchmark consisting of seven document-level tasks ranging from citation prediction, to document classification and recommendation.',
        reference: 'https://allenai.org/data/scidocs',
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'ndcg_at_10',
        date: ['2000-01-01', '2020-12-31'],
        domains: ['Academic', 'Written', 'Non-fiction'],
        taskSubtypes: ['Scientific Reranking'],
        license: 'cc-by-sa-4.0',
        annotationsCreators: 'derived',
        dialect: [],
        sampleCreation: 'found',
        bibtexCitation: String.raw`
@inproceedings{specter2020cohan,
  author = {Arman Cohan and Sergey Feldman and Iz Beltagy and Doug Downey and Daniel S. Weld},
  booktitle = {ACL},
  title = {SPECTER: Document-level Representation Learning using Citation-informed Transformers},
  year = {2020},
}
`,
        prompt: {
          query:
            'Given a scientific paper title, retrieve paper abstracts that are cited by the given paper',
        },
      }),
    });
  }
}
