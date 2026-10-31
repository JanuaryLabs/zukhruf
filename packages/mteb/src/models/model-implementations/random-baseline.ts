import { batchColumn } from '../../create-dataloaders.ts';
import type { BatchedInput } from '../../types/encoder-io.ts';
import {
  type LoadKwargs,
  type LoaderOptions,
  ModelMeta,
} from '../model-meta.ts';
import type { CrossEncoderProtocol } from '../models-protocols.ts';

// mteb/models/model_implementations/random_baseline.py: NoRerankingBaseline
// and its metadata. The random encoders of that module are not ported.

// A reranking baseline that keeps the order of the first stage. A reranking
// task gives the candidates of each query in the order of the first stage,
// so the score of each pair is minus its position among the pairs of its
// query.
export class NoRerankingBaseline implements CrossEncoderProtocol {
  readonly mtebModelMeta: ModelMeta;

  constructor(options: { readonly modelMeta: ModelMeta }) {
    this.mtebModelMeta = options.modelMeta;
  }

  async predict(inputs1: readonly BatchedInput[]): Promise<Float32Array> {
    const queryIds = batchColumn(inputs1, 'id');
    const scores = new Float32Array(queryIds.length);
    let rank = 0;
    for (const [index, queryId] of queryIds.entries()) {
      rank = index > 0 && queryId === queryIds[index - 1] ? rank + 1 : 0;
      // Python negates an int, and minus 0 is 0, not -0.
      scores[index] = 0 - rank;
    }
    return scores;
  }
}

function noRerankingLoader(
  _name: string,
  _revision: string | null,
  options: LoaderOptions<NoRerankingKwargs>,
): NoRerankingBaseline {
  return new NoRerankingBaseline(options);
}
// model_meta.json names a loader by MTEB's __name__, and MTEB finds the loader
// in its registry by that name.
Object.defineProperty(noRerankingLoader, 'name', {
  value: 'NoRerankingBaseline',
});

export type NoRerankingKwargs = LoadKwargs & { readonly model?: never };

export const noRerankingBaseline = new ModelMeta<
  NoRerankingKwargs,
  NoRerankingBaseline
>({
  loader: noRerankingLoader,
  name: 'mteb/baseline-no-reranking',
  revision: '2',
  modelType: ['cross-encoder'],
  embedDim: null,
  similarityFnName: null,
  // _common_mock_metadata of MTEB.
  languages: null,
  openWeights: true,
  releaseDate: null,
  nParameters: 0,
  nEmbeddingParameters: 0,
  memoryUsageMb: 0,
  license: 'mit',
  maxTokens: Infinity,
  reference: null,
  framework: [],
  useInstructions: false,
  publicTrainingCode: null,
  publicTrainingData: null,
  trainingDatasets: [],
  modalities: ['text', 'image', 'audio', 'video'],
});
