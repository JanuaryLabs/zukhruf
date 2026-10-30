import { AbsTaskRetrieval } from '../../../abstasks/retrieval.ts';
import { TaskMetadata } from '../../../abstasks/task-metadata.ts';
import type { HubOptions } from '../../../dependencies/datasets.ts';

// mteb/tasks/retrieval/eng/argu_ana_retrieval.py. A query is an argument and
// the corpus holds it too, so a document with the id of its query does not
// count.
export class ArguAna extends AbsTaskRetrieval {
  override ignoreIdenticalIds = true;

  constructor(options: { readonly hub?: HubOptions } = {}) {
    super({
      ...options,
      metadata: new TaskMetadata({
        name: 'ArguAna',
        description:
          'ArguAna: Retrieval of the Best Counterargument without Prior Topic Knowledge',
        reference: 'http://argumentation.bplaced.net/arguana/data',
        dataset: {
          path: 'mteb/arguana',
          revision: 'c22ab2a51041ffd869aaddef7af8d8215647e41a',
        },
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'ndcg_at_10',
        // Best guess: based on the publication date.
        date: ['2018-01-01', '2018-07-01'],
        domains: ['Social', 'Web', 'Written'],
        taskSubtypes: ['Discourse coherence'],
        license: 'cc-by-sa-4.0',
        annotationsCreators: 'derived',
        dialect: [],
        sampleCreation: 'found',
        bibtexCitation: String.raw`
@inproceedings{wachsmuth2018retrieval,
  author = {Wachsmuth, Henning and Syed, Shahbaz and Stein, Benno},
  booktitle = {ACL},
  title = {Retrieval of the Best Counterargument without Prior Topic Knowledge},
  year = {2018},
}
`,
        prompt: {
          query: 'Given a claim, find documents that refute the claim',
        },
      }),
    });
  }
}
