import { zipStrictMismatch } from '../../dependencies/python.ts';
import type { BatchedInput } from '../../types/encoder-io.ts';
import { AiSdkTextReranker, pairUp } from '../ai-sdk-text-reranker.ts';
import {
  type CrossEncoderKwargs,
  type LoaderOptions,
  ModelMeta,
} from '../model-meta.ts';
import type { PredictOptions } from '../models-protocols.ts';

// mteb/models/model_implementations/qwen3_reranker.py. The loader takes the AI
// SDK reranking model of a server that serves the weights (llama.cpp with
// --rerank, vLLM) in place of loading the causal LM with transformers. MTEB
// scores a pair with the softmax of the logits of "yes" and "no" after its
// own prompt: "<Instruct>: <instruction>\n<Query>: <query>\n<Document>:
// <document>". The server applies the prompt of its template, with its own
// instruction. Thus the scores are not those of MTEB (#3466).

// The text of the query with its instruction, and the text of the document,
// as MTEB puts them after <Query> and <Document>.
export class Qwen3RerankerWrapper extends AiSdkTextReranker {
  protected pairs(
    inputs1: readonly BatchedInput[],
    inputs2: readonly BatchedInput[],
    options: PredictOptions,
  ): [query: string, document: string][] {
    const queries = inputs1.flatMap((batch) => batch.text);
    const passages = inputs2.flatMap((batch) => batch.text);
    // MTEB zips the instructions, the queries and the passages of each batch
    // of batchSize queries. The instructions are as many as the queries.
    const batchSize = options.batchSize ?? 32;
    for (let start = 0; start < queries.length; start += batchSize) {
      const size = Math.min(batchSize, queries.length - start);
      const mismatch = zipStrictMismatch([
        size,
        size,
        Math.max(0, Math.min(batchSize, passages.length - start)),
      ]);
      if (mismatch !== null) throw new Error(mismatch);
    }
    return pairUp(queries, passages);
  }
}

function qwen3RerankerLoader(
  _name: string,
  _revision: string | null,
  options: LoaderOptions<CrossEncoderKwargs>,
): Qwen3RerankerWrapper {
  return new Qwen3RerankerWrapper({
    model: options.model,
    modelMeta: options.modelMeta,
  });
}
// model_meta.json names a loader by MTEB's __name__, and MTEB finds the loader
// in its registry by that name.
Object.defineProperty(qwen3RerankerLoader, 'name', {
  value: 'Qwen3RerankerWrapper',
});

// source: https://arxiv.org/pdf/2506.05176, without NLI, simclue, multi-cpr
// and the synthetic data.
const QWEN3_RERANKER_TRAINING_DATA = [
  'MIRACLReranking',
  'DuRetrieval',
  'MrTidyRetrieval',
  'T2Reranking',
  'MSMARCO',
  'NQ',
  'HotpotQA',
  'CodeSearchNet',
  'MultiLongDocRetrieval',
];

const QWEN3_CITATION =
  '@article{qwen3embedding,\n  title={Qwen3 Embedding: Advancing Text Embedding and Reranking Through Foundation Models},\n  author={Zhang, Yanzhao and Li, Mingxin and Long, Dingkun and Zhang, Xin and Lin, Huan and Yang, Baosong and Xie, Pengjun and Yang, An and Liu, Dayiheng and Lin, Junyang and Huang, Fei and Zhou, Jingren},\n  journal={arXiv preprint arXiv:2506.05176},\n  year={2025}\n}';

export const qwen3Reranker0B6 = new ModelMeta({
  loader: qwen3RerankerLoader,
  loaderKwargs: { dtype: 'bfloat16' },
  name: 'Qwen/Qwen3-Reranker-0.6B',
  revision: '6e9e69830b95c52b5fd889b7690dda3329508de3',
  releaseDate: '2025-05-29',
  languages: null,
  nParameters: 595776512,
  nEmbeddingParameters: 155309056,
  memoryUsageMb: 1136.0,
  maxTokens: 40960,
  embedDim: 1024,
  license: 'apache-2.0',
  openWeights: true,
  publicTrainingCode: null,
  publicTrainingData: null,
  framework: ['PyTorch', 'Transformers', 'safetensors'],
  reference: 'https://huggingface.co/Qwen/Qwen3-Reranker-0.6B',
  similarityFnName: null,
  useInstructions: true,
  trainingDatasets: QWEN3_RERANKER_TRAINING_DATA,
  adaptedFrom: null,
  supersededBy: null,
  modalities: ['text'],
  modelType: ['cross-encoder'],
  citation: QWEN3_CITATION,
  contacts: null,
  outputDtypes: 'bfloat16',
});

export const qwen3Reranker4B = new ModelMeta({
  loader: qwen3RerankerLoader,
  loaderKwargs: { dtype: 'bfloat16' },
  name: 'Qwen/Qwen3-Reranker-4B',
  revision: 'f16fc5d5d2b9b1d0db8280929242745d79794ef5',
  releaseDate: '2025-06-03',
  languages: null,
  nParameters: 4021784576,
  nEmbeddingParameters: 388272640,
  memoryUsageMb: 7671.0,
  maxTokens: 40960,
  embedDim: 2560,
  license: 'apache-2.0',
  openWeights: true,
  publicTrainingCode: null,
  publicTrainingData: null,
  framework: ['PyTorch', 'Transformers', 'safetensors'],
  reference: 'https://huggingface.co/Qwen/Qwen3-Reranker-4B',
  similarityFnName: null,
  useInstructions: true,
  trainingDatasets: QWEN3_RERANKER_TRAINING_DATA,
  adaptedFrom: null,
  supersededBy: null,
  modalities: ['text'],
  modelType: ['cross-encoder'],
  citation: QWEN3_CITATION,
  contacts: null,
  outputDtypes: 'bfloat16',
});

export const qwen3Reranker8B = new ModelMeta({
  loader: qwen3RerankerLoader,
  loaderKwargs: { dtype: 'bfloat16' },
  name: 'Qwen/Qwen3-Reranker-8B',
  revision: '5fa94080caafeaa45a15d11f969d7978e087a3db',
  releaseDate: '2025-05-29',
  languages: null,
  nParameters: 8188548096,
  nEmbeddingParameters: 621236224,
  memoryUsageMb: 15618.0,
  maxTokens: 40960,
  embedDim: 4096,
  license: 'apache-2.0',
  openWeights: true,
  publicTrainingCode: null,
  publicTrainingData: null,
  framework: ['PyTorch', 'Transformers', 'safetensors'],
  reference: 'https://huggingface.co/Qwen/Qwen3-Reranker-8B',
  similarityFnName: null,
  useInstructions: true,
  trainingDatasets: QWEN3_RERANKER_TRAINING_DATA,
  adaptedFrom: null,
  supersededBy: null,
  modalities: ['text'],
  modelType: ['cross-encoder'],
  citation: QWEN3_CITATION,
  contacts: null,
  outputDtypes: 'bfloat16',
});
