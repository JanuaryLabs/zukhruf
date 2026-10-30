import type { PromptType } from '../../types/encoder-io.ts';
import { InstructAiSdkEncoder } from '../instruct-wrapper.ts';
import {
  type EncoderKwargs,
  type LoaderOptions,
  ModelMeta,
} from '../model-meta.ts';

// mteb/models/model_implementations/qwen3_models.py. The loader takes the AI
// SDK embedding model of a server that serves the weights (llama.cpp with
// --pooling last, vLLM, Ollama) in place of loading them with
// SentenceTransformer.

// "Instruct: <instruction>\nQuery:" before a query; nothing before a
// document.
export function instructionTemplate(
  instruction: string | Readonly<Partial<Record<PromptType, string>>>,
  promptType: PromptType | null = null,
): string {
  if (!instruction || promptType === 'document') return '';
  const text =
    typeof instruction === 'string'
      ? instruction
      : promptType === null
        ? (Object.values(instruction)[0] ?? '')
        : (instruction[promptType] ?? '');
  return `Instruct: ${text}\nQuery:`;
}

const MULTILINGUAL_LANGS = [
  'afr-Latn',
  'ara-Arab',
  'aze-Latn',
  'bel-Cyrl',
  'bul-Cyrl',
  'ben-Beng',
  'cat-Latn',
  'ceb-Latn',
  'ces-Latn',
  'cym-Latn',
  'dan-Latn',
  'deu-Latn',
  'ell-Grek',
  'eng-Latn',
  'spa-Latn',
  'est-Latn',
  'eus-Latn',
  'fas-Arab',
  'fin-Latn',
  'fra-Latn',
  'glg-Latn',
  'guj-Gujr',
  'heb-Hebr',
  'hin-Deva',
  'hrv-Latn',
  'hat-Latn',
  'hun-Latn',
  'hye-Armn',
  'ind-Latn',
  'isl-Latn',
  'ita-Latn',
  'jpn-Jpan',
  'jav-Latn',
  'kat-Geor',
  'kaz-Cyrl',
  'khm-Khmr',
  'kan-Knda',
  'kor-Hang',
  'kir-Cyrl',
  'lao-Laoo',
  'lit-Latn',
  'lav-Latn',
  'mkd-Cyrl',
  'mal-Mlym',
  'mon-Cyrl',
  'mar-Deva',
  'msa-Latn',
  'mya-Mymr',
  'nep-Deva',
  'nld-Latn',
  'nor-Latn',
  'nob-Latn',
  'nno-Latn',
  'pan-Guru',
  'pol-Latn',
  'por-Latn',
  'que-Latn',
  'ron-Latn',
  'rus-Cyrl',
  'sin-Sinh',
  'slk-Latn',
  'slv-Latn',
  'swa-Latn',
  'tam-Taml',
  'tel-Telu',
  'tha-Thai',
  'tgl-Latn',
  'tur-Latn',
  'ukr-Cyrl',
  'urd-Arab',
  'vie-Latn',
  'yor-Latn',
  'zho-Hans',
];

const QWEN3_CITATION =
  '@article{qwen3embedding,\n  title={Qwen3 Embedding: Advancing Text Embedding and Reranking Through Foundation Models},\n  author={Zhang, Yanzhao and Li, Mingxin and Long, Dingkun and Zhang, Xin and Lin, Huan and Yang, Baosong and Xie, Pengjun and Yang, An and Liu, Dayiheng and Lin, Junyang and Huang, Fei and Zhou, Jingren},\n  journal={arXiv preprint arXiv:2506.05176},\n  year={2025}\n}';

const TRAINING_DATA = [
  'CMedQAv2-reranking',
  'CodeSearchNet',
  'DuRetrieval',
  'FEVER',
  'HotpotQA',
  'MIRACLRetrieval',
  'MMarcoReranking',
  'MSMARCO',
  'MrTidyRetrieval',
  'NQ',
  'T2Retrieval',
];

function q3eInstructLoader(
  _name: string,
  _revision: string | null,
  options: LoaderOptions<EncoderKwargs>,
): InstructAiSdkEncoder {
  return new InstructAiSdkEncoder({
    model: options.model,
    modelMeta: options.modelMeta,
    instructionTemplate,
    applyInstructionToPassages: false,
  });
}
// model_meta.json names a loader by MTEB's __name__, and MTEB finds the loader
// in its registry by that name.
Object.defineProperty(q3eInstructLoader, 'name', {
  value: 'q3e_instruct_loader',
});

export const qwen3Embedding0B6 = new ModelMeta({
  loader: q3eInstructLoader,
  name: 'Qwen/Qwen3-Embedding-0.6B',
  revision: 'b22da495047858cce924d27d76261e96be6febc0',
  releaseDate: '2025-06-05',
  languages: MULTILINGUAL_LANGS,
  nParameters: 595776512,
  memoryUsageMb: 1136.0,
  maxTokens: 32768.0,
  embedDim: 1024,
  license: 'apache-2.0',
  openWeights: true,
  publicTrainingCode: null,
  publicTrainingData: null,
  framework: [
    'Sentence Transformers',
    'PyTorch',
    'safetensors',
    'Transformers',
  ],
  similarityFnName: 'cosine',
  useInstructions: true,
  trainingDatasets: TRAINING_DATA,
  nEmbeddingParameters: 155309056,
  reference: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B',
  citation: QWEN3_CITATION,
  outputDtypes: 'bfloat16',
});

export const qwen3Embedding4B = new ModelMeta({
  loader: q3eInstructLoader,
  name: 'Qwen/Qwen3-Embedding-4B',
  revision: '636cd9bf47d976946cdbb2b0c3ca0cb2f8eea5ff',
  releaseDate: '2025-06-05',
  languages: MULTILINGUAL_LANGS,
  nParameters: 4021774336,
  memoryUsageMb: 7671.0,
  maxTokens: 32768.0,
  embedDim: 2560,
  license: 'apache-2.0',
  openWeights: true,
  publicTrainingCode: null,
  publicTrainingData: null,
  framework: [
    'Sentence Transformers',
    'PyTorch',
    'safetensors',
    'Transformers',
  ],
  similarityFnName: 'cosine',
  useInstructions: true,
  trainingDatasets: TRAINING_DATA,
  nEmbeddingParameters: 388262400,
  reference: 'https://huggingface.co/Qwen/Qwen3-Embedding-4B',
  citation: QWEN3_CITATION,
  outputDtypes: 'bfloat16',
});

export const qwen3Embedding8B = new ModelMeta({
  loader: q3eInstructLoader,
  name: 'Qwen/Qwen3-Embedding-8B',
  revision: '4e423935c619ae4df87b646a3ce949610c66241c',
  releaseDate: '2025-06-05',
  languages: MULTILINGUAL_LANGS,
  nParameters: 7567295488,
  memoryUsageMb: 14433.0,
  maxTokens: 32768.0,
  embedDim: 4096,
  license: 'apache-2.0',
  openWeights: true,
  publicTrainingCode: null,
  publicTrainingData: null,
  framework: [
    'Sentence Transformers',
    'PyTorch',
    'safetensors',
    'Transformers',
  ],
  similarityFnName: 'cosine',
  useInstructions: true,
  trainingDatasets: TRAINING_DATA,
  nEmbeddingParameters: 621219840,
  reference: 'https://huggingface.co/Qwen/Qwen3-Embedding-8B',
  citation: QWEN3_CITATION,
  outputDtypes: 'bfloat16',
});
