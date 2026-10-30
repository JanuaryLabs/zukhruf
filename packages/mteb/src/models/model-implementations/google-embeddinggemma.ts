import type { EmbeddingModel } from 'ai';

import {
  PROGRAMMING_LANGS,
  type TaskMetadata,
} from '../../abstasks/task-metadata.ts';
import type { BatchedInput } from '../../types/encoder-io.ts';
import { AiSdkTextEncoder } from '../ai-sdk-text-encoder.ts';
import {
  type EncoderKwargs,
  type LoaderOptions,
  ModelMeta,
} from '../model-meta.ts';
import type { EncodeOptions } from '../models-protocols.ts';

// mteb/models/model_implementations/google_embeddinggemma.py: the text path of
// the EmbeddingGemma 2 recipe. One instruction for each task; a query or a
// symmetric input is "task: <instruction> | query: <text>", and a document of
// a retrieval task is "title: <title, or none> | text: <body>". The image and
// audio towers (MIEB, MAEB) and embeddinggemma-300m are not ported yet.

// The instruction of each task that MTEB's EmbeddingGemma 2 numbers used.
export const EMBEDDING_GEMMA_2_TASK_INSTRUCTIONS: Readonly<
  Record<string, string>
> = {
  AfriSentiClassification: 'classification',
  AILAStatutes: 'search result',
  'AlloProfClusteringS2S.v2': 'clustering',
  AlloprofReranking: 'search result',
  AmazonCounterfactualClassification: 'classification',
  AppsRetrieval: 'code retrieval',
  ArguAna: 'fact checking',
  ArmenianParaphrasePC: 'classification',
  AROCocoOrder: 'sentence similarity',
  AROFlickrOrder: 'sentence similarity',
  AROVisualAttribution: 'search result',
  AROVisualRelation: 'classification',
  ArXivHierarchicalClusteringP2P: 'clustering',
  ArXivHierarchicalClusteringS2S: 'clustering',
  AskUbuntuDupQuestions: 'search result',
  Banking77Classification: 'classification',
  BeijingOpera: 'classification',
  BelebeleRetrieval: 'question answering',
  BibleNLPBitextMining: 'search result',
  'BigPatentClustering.v2': 'clustering',
  'BiorxivClusteringP2P.v2': 'clustering',
  BIOSSES: 'sentence similarity',
  BirdCLEF: 'classification',
  BLINKIT2IMultiChoice: 'search result',
  BornholmBitextMining: 'sentence similarity',
  BrazilianToxicTweetsClassification: 'classification',
  'BUCC.v2': 'sentence similarity',
  BulgarianStoreReviewSentimentClassfication: 'classification',
  CataloniaTweetClassification: 'classification',
  CEDRClassification: 'classification',
  CIFAR100ZeroShot: 'sentence similarity',
  CIRRIT2IRetrieval: 'search result',
  ClimateFEVERHardNegatives: 'question answering',
  ClothoT2ARetrieval: 'search result',
  'CLSClusteringP2P.v2': 'clustering',
  CodeEditSearchRetrieval: 'code retrieval',
  CodeFeedbackMT: 'code retrieval',
  CodeFeedbackST: 'code retrieval',
  CodeSearchNetCCRetrieval: 'code retrieval',
  CodeSearchNetRetrieval: 'code retrieval',
  CodeTransOceanContest: 'code retrieval',
  CodeTransOceanDL: 'code retrieval',
  COIRCodeSearchNetRetrieval: 'code retrieval',
  CommonLanguageAgeDetection: 'clustering',
  CommonVoiceMini21T2ARetrieval: 'sentence similarity',
  Core17InstructionRetrieval: 'question answering',
  CosQA: 'code retrieval',
  Country211: 'clustering',
  Country211ZeroShot: 'classification',
  CovidRetrieval: 'search result',
  CQADupstackGamingRetrieval: 'search result',
  CQADupstackUnixRetrieval: 'question answering',
  CREMA_D: 'clustering',
  CREMA_DClustering: 'clustering',
  CREMADPairClassification: 'clustering',
  CSFDSKMovieReviewSentimentClassification: 'classification',
  CTKFactsNLI: 'classification',
  CUB200I2IRetrieval: 'clustering',
  CVBenchCount: 'question answering',
  CVBenchDepth: 'question answering',
  CVBenchDistance: 'classification',
  CVBenchRelation: 'classification',
  CyrillicTurkicLangClassification: 'clustering',
  CzechProductReviewSentimentClassification: 'classification',
  DalajClassification: 'classification',
  DBpediaClassification: 'classification',
  DiaBlaBitextMining: 'sentence similarity',
  DTD: 'classification',
  EstonianValenceClassification: 'classification',
  EuroSAT: 'classification',
  FaroeseSTS: 'sentence similarity',
  Fashion200kI2TRetrieval: 'search result',
  FER2013ZeroShot: 'classification',
  FEVERHardNegatives: 'search result',
  FGVCAircraftZeroShot: 'classification',
  FilipinoShopeeReviewsClassification: 'classification',
  FinancialPhrasebankClassification: 'classification',
  FinParaSTS: 'sentence similarity',
  FiQA2018: 'question answering',
  FleursT2ARetrieval: 'search result',
  FloresBitextMining: 'search result',
  Food101ZeroShot: 'classification',
  FSD2019Kaggle: 'classification',
  GermanSTSBenchmark: 'sentence similarity',
  GigaSpeechT2ARetrieval: 'search result',
  GreekLegalCodeClassification: 'classification',
  GTSRB: 'classification',
  GTZANAudioReranking: 'search result',
  GTZANGenre: 'classification',
  GujaratiNewsClassification: 'clustering',
  HagridRetrieval: 'search result',
  'HALClusteringS2S.v2': 'clustering',
  HatefulMemesI2TRetrieval: 'search result',
  HotpotQAHardNegatives: 'question answering',
  IEMOCAPGender: 'clustering',
  ImageCoDe: 'sentence similarity',
  ImageNetDog15Clustering: 'clustering',
  ImdbClassification: 'classification',
  IN22GenBitextMining: 'sentence similarity',
  IndicCrosslingualSTS: 'sentence similarity',
  IndicGenBenchFloresBitextMining: 'sentence similarity',
  IndicLangClassification: 'clustering',
  IndonesianIdClickbaitClassification: 'classification',
  indonli: 'sentence similarity',
  InfoSeekIT2TRetrieval: 'search result',
  IsiZuluNewsClassification: 'classification',
  ItaCaseholdClassification: 'clustering',
  JamAltArtistA2ARetrieval: 'search result',
  JamAltLyricA2TRetrieval: 'search result',
  JSICK: 'sentence similarity',
  KorHateSpeechMLClassification: 'classification',
  KorSarcasmClassification: 'classification',
  KurdishSentimentClassification: 'classification',
  LegalBenchCorporateLobbying: 'search result',
  LEMBPasskeyRetrieval: 'search result',
  MacedonianTweetSentimentClassification: 'classification',
  MACST2ARetrieval: 'search result',
  MalteseNewsClassification: 'clustering',
  MasakhaNEWSClassification: 'clustering',
  MasakhaNEWSClusteringS2S: 'clustering',
  MassiveIntentClassification: 'classification',
  MassiveScenarioClassification: 'classification',
  'MedrxivClusteringP2P.v2': 'clustering',
  'MedrxivClusteringS2S.v2': 'clustering',
  MInDS14: 'classification',
  MindSmallReranking: 'search result',
  MIRACLRetrievalHardNegatives: 'search result',
  MLQARetrieval: 'search result',
  MridinghamTonic: 'classification',
  MTOPDomainClassification: 'classification',
  MultiEURLEXMultilabelClassification: 'classification',
  MultiHateClassification: 'classification',
  NepaliNewsClassification: 'clustering',
  News21InstructionRetrieval: 'search result',
  NIGHTSI2IRetrieval: 'search result',
  NMSQAPairClassification: 'sentence similarity',
  NollySentiBitextMining: 'sentence similarity',
  NordicLangClassification: 'clustering',
  NorwegianCourtsBitextMining: 'sentence similarity',
  NTREXBitextMining: 'search result',
  NusaParagraphEmotionClassification: 'classification',
  NusaTranslationBitextMining: 'sentence similarity',
  'NusaX-senti': 'classification',
  NusaXBitextMining: 'search result',
  OdiaNewsClassification: 'clustering',
  OpusparcusPC: 'sentence similarity',
  OVENIT2TRetrieval: 'question answering',
  OxfordPets: 'classification',
  OxfordPetsZeroShot: 'classification',
  PAC: 'classification',
  PatchCamelyon: 'clustering',
  PawsXPairClassification: 'sentence similarity',
  'PlscClusteringP2P.v2': 'clustering',
  PoemSentimentClassification: 'classification',
  'PolEmo2.0-OUT': 'classification',
  PpcPC: 'sentence similarity',
  PunjabiNewsClassification: 'classification',
  RavdessZeroshot: 'clustering',
  RESISC45: 'classification',
  Robust04InstructionRetrieval: 'question answering',
  RomaniBibleClustering: 'clustering',
  RP2kI2IRetrieval: 'clustering',
  RTE3: 'sentence similarity',
  RuBQReranking: 'search result',
  ScalaClassification: 'classification',
  SCIDOCS: 'question answering',
  SemRel24STS: 'sentence similarity',
  SentimentAnalysisHindi: 'classification',
  SIB200ClusteringS2S: 'clustering',
  SIBFLEURS: 'clustering',
  'SICK-R': 'sentence similarity',
  SinhalaNewsClassification: 'clustering',
  SiswatiNewsClassification: 'classification',
  SlovakMovieReviewSentimentClassification: 'classification',
  SpartQA: 'question answering',
  'SpeechCommandsZeroshotv0.02': 'sentence similarity',
  SpokenSQuADT2ARetrieval: 'search result',
  SprintDuplicateQuestions: 'search result',
  'StackExchangeClustering.v2': 'clustering',
  'StackExchangeClusteringP2P.v2': 'clustering',
  StackOverflowQA: 'code retrieval',
  StanfordCarsZeroShot: 'classification',
  StatcanDialogueDatasetRetrieval: 'search result',
  STS12: 'sentence similarity',
  STS13: 'sentence similarity',
  STS13VisualSTS: 'sentence similarity',
  STS14: 'sentence similarity',
  STS15: 'sentence similarity',
  STS15VisualSTS: 'sentence similarity',
  STS17: 'sentence similarity',
  STS17MultilingualVisualSTS: 'sentence similarity',
  'STS22.v2': 'sentence similarity',
  STSB: 'sentence similarity',
  STSBenchmark: 'sentence similarity',
  STSBenchmarkMultilingualVisualSTS: 'sentence similarity',
  STSES: 'sentence similarity',
  'SummEvalSummarization.v2': 'sentence similarity',
  SUN397: 'classification',
  SwahiliNewsClassification: 'clustering',
  SwednClusteringP2P: 'clustering',
  SwissJudgementClassification: 'classification',
  SyntheticText2SQL: 'code retrieval',
  T2Reranking: 'question answering',
  Tatoeba: 'sentence similarity',
  TempReasonL1: 'search result',
  TERRa: 'sentence similarity',
  TinyImageNetClustering: 'clustering',
  'Touche2020Retrieval.v3': 'question answering',
  ToxicConversationsClassification: 'classification',
  TRECCOVID: 'search result',
  TswanaNewsClassification: 'classification',
  TweetSentimentExtractionClassification: 'classification',
  TweetTopicSingleClassification: 'clustering',
  'TwentyNewsgroupsClustering.v2': 'clustering',
  TwitterHjerneRetrieval: 'search result',
  TwitterSemEval2015: 'sentence similarity',
  TwitterURLCorpus: 'sentence similarity',
  UrbanSound8KT2ARetrieval: 'search result',
  VehicleSoundClustering: 'clustering',
  VidoreDocVQARetrieval: 'question answering',
  VidoreInfoVQARetrieval: 'search result',
  VidoreShiftProjectRetrieval: 'search result',
  VidoreSyntheticDocQAAIRetrieval: 'search result',
  VidoreTabfquadRetrieval: 'question answering',
  VidoreTatdqaRetrieval: 'search result',
  VisualNewsI2TRetrieval: 'search result',
  'VisualSTS-b-Multilingual': 'sentence similarity',
  VisualSTS17Multilingual: 'sentence similarity',
  VoxCelebSA: 'classification',
  VoxPopuliAccentPairClassification: 'clustering',
  VoxPopuliGenderClustering: 'clustering',
  VoxPopuliLanguageID: 'clustering',
  VoyageMMarcoReranking: 'search result',
  VQA2IT2TRetrieval: 'search result',
  WebLINXCandidatesReranking: 'code retrieval',
  WebQAT2ITRetrieval: 'search result',
  WikiCitiesClustering: 'clustering',
  'WikiClusteringP2P.v2': 'classification',
  WikipediaRerankingMultilingual: 'search result',
  WikipediaRetrievalMultilingual: 'search result',
  WinoGrande: 'search result',
  Winoground: 'search result',
  WITT2IRetrieval: 'search result',
  XM3600T2IRetrieval: 'search result',
  XNLI: 'sentence similarity',
};

const TASK_TYPE_INSTRUCTION: Readonly<Record<string, string>> = {
  retrieval: 'search result',
  clustering: 'clustering',
  classification: 'classification',
  'semantic-similarity': 'sentence similarity',
  'pair-classification': 'sentence similarity',
};

// The instruction of the task types that TASK_TYPE_INSTRUCTION does not name
// (_TASK_TYPE_INSTRUCTION.get(task_type, "search result")).
const OTHER_TASK_TYPE_INSTRUCTION = 'search result';

// Retrieval subtypes with a more specific instruction, in order.
const RETRIEVAL_SUBTYPE_INSTRUCTION: Readonly<Record<string, string>> = {
  'Code retrieval': 'code retrieval',
  'Claim verification': 'fact checking',
  'Question answering': 'question answering',
};

// The MIEB tasks that are not retrieval tasks but take the document template.
const MIEB_ASYMMETRIC_TASKS: ReadonlySet<string> = new Set([
  'CIRRIT2IRetrieval',
  'CUB200I2IRetrieval',
  'Fashion200kI2TRetrieval',
  'HatefulMemesI2TRetrieval',
  'InfoSeekIT2TRetrieval',
  'NIGHTSI2IRetrieval',
  'OVENIT2TRetrieval',
  'RP2kI2IRetrieval',
  'VQA2IT2TRetrieval',
  'VidoreDocVQARetrieval',
  'VidoreInfoVQARetrieval',
  'VidoreShiftProjectRetrieval',
  'VidoreSyntheticDocQAAIRetrieval',
  'VidoreTabfquadRetrieval',
  'VidoreTatdqaRetrieval',
  'VisualNewsI2TRetrieval',
  'WITT2IRetrieval',
  'WebQAT2ITRetrieval',
  'XM3600T2IRetrieval',
]);

const PROGRAMMING_LANGUAGES: ReadonlySet<string> = new Set(PROGRAMMING_LANGS);

// The instruction of the simplified task type; for retrieval, refined by
// programming languages and the subtype.
function taskTypeInstruction(taskMetadata: TaskMetadata): string {
  const taskType = taskMetadata.simplifiedTaskType;
  if (taskType === 'retrieval') {
    if (
      taskMetadata.languages.some((language) =>
        PROGRAMMING_LANGUAGES.has(language),
      )
    )
      return 'code retrieval';
    const subtypes: readonly string[] = taskMetadata.taskSubtypes ?? [];
    for (const [subtype, instruction] of Object.entries(
      RETRIEVAL_SUBTYPE_INSTRUCTION,
    ))
      if (subtypes.includes(subtype)) return instruction;
  }
  const instruction = TASK_TYPE_INSTRUCTION[taskType];
  return instruction === undefined ? OTHER_TASK_TYPE_INSTRUCTION : instruction;
}

// The EmbeddingGemma 2 recipe over an AI SDK embedding model that serves the
// weights (llama.cpp, Ollama, vLLM). Only the text tower is loaded, so the
// metadata reports text, and the parameters and memory of that tower.
export class EmbeddingGemma2Encoder extends AiSdkTextEncoder {
  constructor(options: {
    readonly model: Exclude<EmbeddingModel, string>;
    readonly modelMeta: ModelMeta;
    readonly maxRetries?: number;
  }) {
    super({
      ...options,
      modelMeta: options.modelMeta.modelCopy({
        modalities: ['text'],
        nParameters: 271_002_624,
        memoryUsageMb: 1034,
      }),
    });
  }

  static load(
    this: void,
    _name: string,
    _revision: string | null,
    options: LoaderOptions<EncoderKwargs>,
  ): EmbeddingGemma2Encoder {
    return new EmbeddingGemma2Encoder({
      model: options.model,
      modelMeta: options.modelMeta,
    });
  }

  protected texts(
    inputs: readonly BatchedInput[],
    options: EncodeOptions,
  ): string[] {
    const { taskMetadata } = options;
    const name = taskMetadata.name;
    const instruction =
      EMBEDDING_GEMMA_2_TASK_INSTRUCTIONS[name] ||
      taskTypeInstruction(taskMetadata);
    const asymmetric =
      taskMetadata.type === 'Retrieval' ||
      taskMetadata.type === 'Any2AnyRetrieval' ||
      MIEB_ASYMMETRIC_TASKS.has(name);
    const isDocument = asymmetric && options.promptType === 'document';
    return inputs.flatMap((batch) => {
      if (!isDocument)
        return batch.text.map(
          (text) => `task: ${instruction} | query: ${text}`,
        );
      const bodies = 'body' in batch ? batch.body : batch.text;
      const titles = 'title' in batch ? batch.title : batch.text.map(() => '');
      return bodies.map(
        (body, index) =>
          `title: ${(titles[index] ?? '').trim() || 'none'} | text: ${body}`,
      );
    });
  }
}

const MULTILINGUAL_EVALUATED_LANGUAGES = [
  'arb-Arab',
  'ben-Beng',
  'eng-Latn',
  'spa-Latn',
  'deu-Latn',
  'pes-Arab',
  'fin-Latn',
  'fra-Latn',
  'hin-Deva',
  'ind-Latn',
  'jpn-Jpan',
  'kor-Hang',
  'rus-Cyrl',
  'swh-Latn',
  'tel-Telu',
  'tha-Thai',
  'yor-Latn',
  'zho-Hant',
  'zho-Hans',
];

const EMBEDDING_GEMMA_CITATION =
  '\n@misc{vera2025embeddinggemmapowerfullightweighttext,\n      title={EmbeddingGemma: Powerful and Lightweight Text Representations},\n      author={Henrique Schechter Vera and Sahil Dua and Biao Zhang and Daniel Salz and Ryan Mullins and Sindhu Raghuram Panyam and Sara Smoot and Iftekhar Naim and Joe Zou and Feiyang Chen and Daniel Cer and Alice Lisak and Min Choi and Lucas Gonzalez and Omar Sanseviero and Glenn Cameron and Ian Ballantyne and Kat Black and Kaifeng Chen and Weiyi Wang and Zhe Li and Gus Martins and Jinhyuk Lee and Mark Sherwood and Juyeong Ji and Renjie Wu and Jingxiao Zheng and Jyotinder Singh and Abheesht Sharma and Divyashree Sreepathihalli and Aashi Jain and Adham Elarabawy and AJ Co and Andreas Doumanoglou and Babak Samari and Ben Hora and Brian Potetz and Dahun Kim and Enrique Alfonseca and Fedor Moiseev and Feng Han and Frank Palma Gomez and Gustavo Hern\u00e1ndez \u00c1brego and Hesen Zhang and Hui Hui and Jay Han and Karan Gill and Ke Chen and Koert Chen and Madhuri Shanbhogue and Michael Boratko and Paul Suganthan and Sai Meher Karthik Duddu and Sandeep Mariserla and Setareh Ariafar and Shanfeng Zhang and Shijie Zhang and Simon Baumgartner and Sonam Goenka and Steve Qiu and Tanmaya Dabral and Trevor Walker and Vikram Rao and Waleed Khawaja and Wenlei Zhou and Xiaoqi Ren and Ye Xia and Yichang Chen and Yi-Ting Chen and Zhe Dong and Zhongli Ding and Francesco Visin and Ga\u00ebl Liu and Jiageng Zhang and Kathleen Kenealy and Michelle Casbon and Ravin Kumar and Thomas Mesnard and Zach Gleicher and Cormac Brick and Olivier Lacombe and Adam Roberts and Qin Yin and Yunhsuan Sung and Raphael Hoffmann and Tris Warkentin and Armand Joulin and Tom Duerig and Mojtaba Seyedhosseini},\n      year={2025},\n      eprint={2509.20354},\n      archivePrefix={arXiv},\n      primaryClass={cs.CL},\n      url={https://arxiv.org/abs/2509.20354},\n}';

const GECKO_TRAINING_DATA = [
  'FEVERHardNegatives',
  'HotpotQAHardNegatives',
  'MIRACLRetrievalHardNegatives',
  'NQHardNegatives',
];

export const embeddingGemma2 = new ModelMeta({
  loader: EmbeddingGemma2Encoder.load,
  name: 'google/embeddinggemma-2',
  revision: '914f7f89142e33e77833254d9c9b90c3cef7303b',
  releaseDate: '2026-10-06',
  languages: MULTILINGUAL_EVALUATED_LANGUAGES,
  nParameters: 271002624,
  memoryUsageMb: 1034.0,
  maxTokens: 8192.0,
  embedDim: [768, 512, 256, 128],
  license: 'gemma',
  openWeights: true,
  publicTrainingCode: null,
  publicTrainingData: null,
  framework: ['Sentence Transformers', 'PyTorch', 'safetensors'],
  similarityFnName: 'cosine',
  useInstructions: true,
  trainingDatasets: GECKO_TRAINING_DATA,
  nEmbeddingParameters: 134217728,
  reference: 'https://huggingface.co/google/embeddinggemma-2',
  modalities: ['text', 'image', 'audio', 'video'],
  citation: EMBEDDING_GEMMA_CITATION,
  extraRequirementsGroups: ['embeddinggemma'],
});
