import { AbsTaskClusteringLegacy } from '../../../abstasks/clustering-legacy.ts';
import {
  AbsTaskClustering,
  checkLabelDistribution,
} from '../../../abstasks/clustering.ts';
import { TaskMetadata } from '../../../abstasks/task-metadata.ts';
import type { HubOptions } from '../../../dependencies/datasets.ts';

// mteb/tasks/clustering/eng/biorxiv_clustering_s2s.py.

// BiorxivClusteringS2SFast.
export class BiorxivClusteringS2SFast extends AbsTaskClustering {
  constructor(options: { readonly hub?: HubOptions } = {}) {
    super({
      ...options,
      metadata: new TaskMetadata({
        name: 'BiorxivClusteringS2S.v2',
        description: 'Clustering of titles from biorxiv across 26 categories.',
        dataset: {
          path: 'mteb/biorxiv-clustering-s2s',
          revision: 'eb4edb10386758d274cd161093eb351381a16dbf',
        },
        reference: 'https://api.biorxiv.org/',
        type: 'Clustering',
        category: 't2c',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'v_measure',
        date: ['2021-01-01', '2022-05-10'],
        domains: ['Academic', 'Written'],
        taskSubtypes: ['Thematic clustering'],
        license: 'https://www.biorxiv.org/content/about-biorxiv',
        annotationsCreators: 'derived',
        dialect: [],
        sampleCreation: 'created',
        bibtexCitation: '',
        prompt:
          'Identify the main category of Biorxiv papers based on the titles',
        adaptedFrom: ['BiorxivClusteringS2S'],
      }),
    });
  }

  override datasetTransform(): void {
    for (const split of this.metadata.evalSplits) {
      const data = this.dataset?.get('default')?.get(split);
      if (data === undefined) throw new Error(`KeyError: '${split}'`);
      checkLabelDistribution(data);
    }
  }
}

// BiorxivClusteringS2S.
export class BiorxivClusteringS2S extends AbsTaskClusteringLegacy {
  constructor(options: { readonly hub?: HubOptions } = {}) {
    super({
      ...options,
      metadata: new TaskMetadata({
        name: 'BiorxivClusteringS2S',
        description:
          'Clustering of titles from biorxiv. Clustering of 10 sets, based on the main category.',
        dataset: {
          path: 'mteb/biorxiv-clustering-s2s',
          revision: '258694dd0231531bc1fd9de6ceb52a0853c6d908',
        },
        reference: 'https://api.biorxiv.org/',
        type: 'Clustering',
        category: 't2c',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'v_measure',
        date: ['2021-01-01', '2022-05-10'],
        domains: ['Academic', 'Written'],
        taskSubtypes: ['Thematic clustering'],
        license: 'https://www.biorxiv.org/content/about-biorxiv',
        annotationsCreators: 'derived',
        dialect: [],
        sampleCreation: 'created',
        bibtexCitation: '',
        prompt:
          'Identify the main category of Biorxiv papers based on the titles',
        supersededBy: 'BiorxivClusteringS2S.v2',
      }),
    });
  }
}
