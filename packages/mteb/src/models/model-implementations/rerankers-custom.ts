import { batchColumn } from '../../create-dataloaders.ts';
import { zipStrictMismatch } from '../../dependencies/python.ts';
import type { BatchedInput } from '../../types/encoder-io.ts';
import { AiSdkTextReranker, pairUp } from '../ai-sdk-text-reranker.ts';
import {
  type CrossEncoderKwargs,
  type LoaderOptions,
  ModelMeta,
  type ModelMetaInput,
} from '../model-meta.ts';
import {
  type CrossEncoderWrapper,
  crossEncoderWrapperLoader,
} from '../sentence-transformer-wrapper.ts';
import { bgeM3TrainingData } from './bge-models.ts';

// mteb/models/model_implementations/rerankers_custom.py. The loaders take the
// AI SDK reranking model of a server that serves the weights (llama.cpp with
// --rerank, vLLM, TEI) in place of loading them with FlagEmbedding or
// sentence-transformers. The server applies the activation of the model, such
// as the sigmoid of FlagReranker's normalize. RerankerWrapper only chooses a
// torch dtype and a device, so it is not ported.

// The texts of the queries without their instructions: MTEB looks for an
// instruction column in the documents, which have none.
function queriesAndPassages(
  inputs1: readonly BatchedInput[],
  inputs2: readonly BatchedInput[],
): [queries: string[], passages: string[]] {
  return [
    batchColumn(inputs1, 'query').map(String),
    inputs2.flatMap((batch) => batch.text),
  ];
}

// The query of each pair, and the text of the document.
export class BGEReranker extends AiSdkTextReranker {
  protected pairs(
    inputs1: readonly BatchedInput[],
    inputs2: readonly BatchedInput[],
  ): [query: string, document: string][] {
    const [queries, passages] = queriesAndPassages(inputs1, inputs2);
    if (queries.length !== passages.length)
      throw new Error(
        `Expected ${queries.length} passages, got ${passages.length}`,
      );
    return pairUp(queries, passages);
  }
}

// The query of each pair, and the text of the document.
export class JinaReranker extends AiSdkTextReranker {
  protected pairs(
    inputs1: readonly BatchedInput[],
    inputs2: readonly BatchedInput[],
  ): [query: string, document: string][] {
    const [queries, passages] = queriesAndPassages(inputs1, inputs2);
    const mismatch = zipStrictMismatch([queries.length, passages.length]);
    if (mismatch !== null) throw new Error(mismatch);
    return pairUp(queries, passages);
  }
}

function bgeRerankerLoader(
  _name: string,
  _revision: string | null,
  options: LoaderOptions<CrossEncoderKwargs>,
): BGEReranker {
  return new BGEReranker({
    model: options.model,
    modelMeta: options.modelMeta,
  });
}
// model_meta.json names a loader by MTEB's __name__, and MTEB finds the loader
// in its registry by that name.
Object.defineProperty(bgeRerankerLoader, 'name', { value: 'BGEReranker' });

function jinaRerankerLoader(
  _name: string,
  _revision: string | null,
  options: LoaderOptions<CrossEncoderKwargs>,
): JinaReranker {
  return new JinaReranker({
    model: options.model,
    modelMeta: options.modelMeta,
  });
}
Object.defineProperty(jinaRerankerLoader, 'name', { value: 'JinaReranker' });

// languages unclear: https://huggingface.co/jinaai/jina-reranker-v2-base-multilingual/discussions/28
export const jinaRerankerMultilingual = new ModelMeta({
  loader: jinaRerankerLoader,
  loaderKwargs: { fp_options: 'float16' },
  name: 'jinaai/jina-reranker-v2-base-multilingual',
  modelType: ['cross-encoder'],
  languages: ['eng-Latn'],
  openWeights: true,
  revision: '126747772a932960028d9f4dc93bd5d9c4869be4',
  releaseDate: '2024-09-26',
  nParameters: null,
  nEmbeddingParameters: null,
  memoryUsageMb: 531,
  maxTokens: null,
  embedDim: null,
  license: null,
  publicTrainingCode: null,
  publicTrainingData: null,
  similarityFnName: null,
  useInstructions: null,
  trainingDatasets: null,
  framework: [
    'Sentence Transformers',
    'PyTorch',
    'Transformers',
    'ONNX',
    'safetensors',
  ],
  // Loaded with torch_dtype="auto"; fp_options is not applied.
  outputDtypes: 'bfloat16',
});

export const bgeRerankerV2M3 = new ModelMeta({
  loader: bgeRerankerLoader,
  loaderKwargs: { fp_options: 'float16' },
  name: 'BAAI/bge-reranker-v2-m3',
  modelType: ['cross-encoder'],
  languages: [
    'eng-Latn',
    'ara-Arab',
    'ben-Beng',
    'spa-Latn',
    'fas-Arab',
    'fin-Latn',
    'fra-Latn',
    'hin-Deva',
    'ind-Latn',
    'jpn-Jpan',
    'kor-Hang',
    'rus-Cyrl',
    'swa-Latn',
    'tel-Telu',
    'tha-Thai',
    'zho-Hans',
    'deu-Latn',
    'yor-Latn',
    'dan-Latn',
    'heb-Hebr',
    'hun-Latn',
    'ita-Latn',
    'khm-Khmr',
    'msa-Latn',
    'nld-Latn',
    'nob-Latn',
    'pol-Latn',
    'por-Latn',
    'swe-Latn',
    'tur-Latn',
    'vie-Latn',
    'zho-Hant',
  ],
  openWeights: true,
  revision: '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e',
  releaseDate: '2024-06-24',
  nParameters: null,
  nEmbeddingParameters: 256_002_048,
  memoryUsageMb: 2166,
  maxTokens: null,
  embedDim: null,
  license: null,
  publicTrainingCode: null,
  publicTrainingData: null,
  similarityFnName: null,
  useInstructions: null,
  trainingDatasets: [...bgeM3TrainingData],
  framework: [
    'Sentence Transformers',
    'PyTorch',
    'safetensors',
    'Transformers',
  ],
  citation: `
@inproceedings{li2023making,
  address = {Bangkok, Thailand},
  author = {Li, Chaofan and Liu, Zheng and Xiao, Shitao and Shao, Yingxia and Lian, Defu},
  booktitle = {Proceedings of the 62nd Annual Meeting of the {A}ssociation for {C}omputational {L}inguistics (Volume 1: Long Papers)},
  doi = {10.18653/v1/2024.acl-long.191},
  editor = {Ku, Lun-Wei and Martins, Andre and Srikumar, Vivek},
  month = {aug},
  pages = {3490--3500},
  publisher = {Association for Computational Linguistics},
  title = {{L}lama2{V}ec: Unsupervised Adaptation of Large Language Models for Dense Retrieval},
  url = {https://aclanthology.org/2024.acl-long.191/},
  year = {2024},
}
    @inproceedings{bge-m3,
  address = {Bangkok, Thailand},
  author = {Chen, Jianlyu and Xiao, Shitao and Zhang, Peitian and Luo, Kun and Lian, Defu and Liu, Zheng},
  booktitle = {Findings of the {A}ssociation for {C}omputational {L}inguistics: {ACL} 2024},
  doi = {10.18653/v1/2024.findings-acl.137},
  editor = {Ku, Lun-Wei and Martins, Andre and Srikumar, Vivek},
  month = {aug},
  pages = {2318--2335},
  publisher = {Association for Computational Linguistics},
  title = {{M}3-Embedding: Multi-Linguality, Multi-Functionality, Multi-Granularity Text Embeddings Through Self-Knowledge Distillation},
  url = {https://aclanthology.org/2024.findings-acl.137/},
  year = {2024},
}
    `,
  extraRequirementsGroups: ['flagembedding'],
  outputDtypes: 'float16',
});

// SBERT MS MARCO CrossEncoders (Version 2 models). Same training/data/citation for all.
const MS_MARCO_V2_COMMON = {
  loader: crossEncoderWrapperLoader,
  modelType: ['cross-encoder'],
  languages: ['eng-Latn'],
  openWeights: true,
  releaseDate: '2021-04-16',
  maxTokens: 512,
  license: 'apache-2.0',
  publicTrainingCode:
    'https://github.com/UKPLab/sentence-transformers/tree/master/examples/cross_encoder/training/ms_marco',
  publicTrainingData:
    'https://huggingface.co/datasets/sentence-transformers/msmarco',
  similarityFnName: null,
  useInstructions: null,
  trainingDatasets: ['MSMARCO'],
  framework: [
    'Sentence Transformers',
    'PyTorch',
    'Transformers',
    'safetensors',
    'ONNX',
  ],
  citation: `@inproceedings{reimers-2019-sentence-bert,
    title = "Sentence-BERT: Sentence Embeddings using Siamese BERT-Networks",
    author = "Reimers, Nils and Gurevych, Iryna",
    booktitle = "Proceedings of the 2019 Conference on Empirical Methods in Natural Language Processing",
    month = "11",
    year = "2019",
    publisher = "Association for Computational Linguistics",
    url = "https://arxiv.org/abs/1908.10084",
}
`,
} satisfies Partial<ModelMetaInput<CrossEncoderKwargs, CrossEncoderWrapper>>;

export const msMarcoTinybertL2V2 = new ModelMeta({
  ...MS_MARCO_V2_COMMON,
  name: 'cross-encoder/ms-marco-TinyBERT-L2-v2',
  revision: '81d1926f67cb8eee2c2be17ca9f793c7c3bd20cc',
  nParameters: 4_386_049,
  nEmbeddingParameters: 3_906_816,
  memoryUsageMb: 17,
  embedDim: 128,
  reference: 'https://huggingface.co/cross-encoder/ms-marco-TinyBERT-L2-v2',
});

export const msMarcoMinilmL2V2 = new ModelMeta({
  ...MS_MARCO_V2_COMMON,
  name: 'cross-encoder/ms-marco-MiniLM-L2-v2',
  revision: '1b5cd67b15209f24824c50370e0397743aa9b787',
  nParameters: 15_615_745,
  nEmbeddingParameters: 11_720_448,
  memoryUsageMb: 60,
  embedDim: 384,
  reference: 'https://huggingface.co/cross-encoder/ms-marco-MiniLM-L2-v2',
});

export const msMarcoMinilmL4V2 = new ModelMeta({
  ...MS_MARCO_V2_COMMON,
  name: 'cross-encoder/ms-marco-MiniLM-L4-v2',
  revision: '777b2f369bc1c2f850df8bd367ed1654bda4497b',
  nParameters: 19_164_673,
  nEmbeddingParameters: 11_720_448,
  memoryUsageMb: 73,
  embedDim: 384,
  reference: 'https://huggingface.co/cross-encoder/ms-marco-MiniLM-L4-v2',
});

export const msMarcoMinilmL6V2 = new ModelMeta({
  ...MS_MARCO_V2_COMMON,
  name: 'cross-encoder/ms-marco-MiniLM-L6-v2',
  revision: 'c5ee24cb16019beea0893ab7796b1df96625c6b8',
  nParameters: 22_713_601,
  nEmbeddingParameters: 11_720_448,
  memoryUsageMb: 87,
  embedDim: 384,
  reference: 'https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2',
});

export const msMarcoMinilmL12V2 = new ModelMeta({
  ...MS_MARCO_V2_COMMON,
  name: 'cross-encoder/ms-marco-MiniLM-L12-v2',
  revision: '7b0235231ca2674cb8ca8f022859a6eba2b1c968',
  nParameters: 33_360_385,
  nEmbeddingParameters: 11_720_448,
  memoryUsageMb: 127,
  embedDim: 384,
  reference: 'https://huggingface.co/cross-encoder/ms-marco-MiniLM-L12-v2',
});
