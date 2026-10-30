// mteb/abstasks/task_metadata.py, with check_language_code of
// mteb/languages/check_language_code.py and the pydantic ValidationError that
// TaskMetadata and ModelMeta throw.
import { z } from 'zod';

import { compareStrings } from '../dependencies/python.ts';
import type { PromptType } from '../types/encoder-io.ts';
import {
  type ISOLanguageScript,
  LICENSES,
  type Languages,
  type Licenses,
  MODALITIES,
  type Modalities,
} from '../types/metadata.ts';
import type { HFSubset } from '../types/result.ts';

// The literal types of task_metadata.py, as const arrays.
export const TASK_SUBTYPES = [
  'Article retrieval',
  'Patent retrieval',
  'Conversational retrieval',
  'Dialect pairing',
  'Dialog Systems',
  'Discourse coherence',
  'Duplicate Image Retrieval',
  'Language identification',
  'Linguistic acceptability',
  'Political classification',
  'Question answering',
  'Sentiment/Hate speech',
  'Thematic clustering',
  'Scientific Reranking',
  'Claim verification',
  'Topic classification',
  'Code retrieval',
  'False Friends',
  'Cross-Lingual Semantic Discrimination',
  'Textual Entailment',
  'Counterfactual Detection',
  'Emotion classification',
  'Reasoning as Retrieval',
  'Rendered Texts Understanding',
  'Image Text Retrieval',
  'Object recognition',
  'Scene recognition',
  'Caption Pairing',
  'Emotion recognition',
  'Event Retrieval',
  'Textures recognition',
  'Activity recognition',
  'Physical plausibility classification',
  'Tumor detection',
  'Duplicate Detection',
  'Rendered semantic textual similarity',
  'Intent classification',
  'Product Reranking',
  'Query-Product Relevance',
  'Accent identification',
  'Environment Sound Classification',
  'Gunshot Audio Classification',
  'Keyword Spotting',
  'Instrument Source Classification',
  'Music Genre Classification',
  'Music Instrument Recognition',
  'Spoken Language Identification',
  'Stroke Classification of Musical Instrument',
  'Tonic Classification of Musical Instrument',
  'Speaker Count Identification',
  'Species Classification',
  'Spoken Digit Classification',
  'Gender Clustering',
  'Vocal Sound Classification',
  'Music Clustering',
  'Accent Clustering',
  'Sentiment Clustering',
  'Emotion Clustering',
  'Sentiment Analysis',
  'Vehicle Clustering',
  'Environment Sound Clustering',
  'Environment Sound Reranking',
  'Emotion Reranking',
  'Music Genre Reranking',
  'Gender Classification',
  'Age Classification',
  'Song Lyrics Retrieval',
  'Natural Sound Retrieval',
  'Music Caption Retrieval',
  'Speech Transcription Retrieval',
  'Emotional Speech Retrieval',
  'Environment Sound Retrieval',
  'Speech Retrieval',
  'Question Answering Retrieval',
  'Reading Comprehension',
  'Intent Classification',
  'Cross-Modal Retrieval',
] as const;

export type TaskSubtype = (typeof TASK_SUBTYPES)[number];

// MTEB lists "Spoken" two times; the list keeps it once.
export const TASK_DOMAINS = [
  'Academic',
  'Blog',
  'Constructed',
  'Encyclopaedic',
  'Engineering',
  'Fiction',
  'Government',
  'Legal',
  'Medical',
  'News',
  'Non-fiction',
  'Poetry',
  'Religious',
  'Reviews',
  'Scene',
  'Social',
  'Spoken',
  'Subtitles',
  'Web',
  'Written',
  'Programming',
  'Chemistry',
  'Financial',
  'Entertainment',
  'E-commerce',
  'AudioScene',
  'Speech',
  'Music',
  'Bioacoustics',
  'Sport',
  'Activity',
  'Instructional',
  'Egocentric',
  'Nature',
  'Animation',
  'Robotics',
] as const;

export type TaskDomain = (typeof TASK_DOMAINS)[number];

export const SAMPLE_CREATION_METHODS = [
  'found',
  'created',
  'created and machine-translated',
  'human-translated and localized',
  'human-translated',
  'machine-translated',
  'machine-translated and verified',
  'machine-translated and localized',
  'LM-generated and verified',
  'machine-translated and LM verified',
  'rendered',
  'multiple',
] as const;

export type SampleCreationMethod = (typeof SAMPLE_CREATION_METHODS)[number];

export const TASK_TYPES = [
  'BitextMining',
  'Classification',
  'MultilabelClassification',
  'Clustering',
  'PairClassification',
  'Regression',
  'Reranking',
  'Retrieval',
  'STS',
  'Summarization',
  'InstructionRetrieval',
  'InstructionReranking',
  'Any2AnyReranking',
  'Any2AnyRetrieval',
  'Any2AnyMultilingualRetrieval',
  'VisionCentricQA',
  'ImageClustering',
  'ImageClassification',
  'DocumentUnderstanding',
  'VisualSTS(eng)',
  'VisualSTS(multi)',
  'ZeroShotClassification',
  'Compositionality',
  'AudioClustering',
  'AudioMultilabelClassification',
  'AudioReranking',
  'AudioZeroshotClassification',
  'AudioClassification',
  'AudioPairClassification',
  'VideoClassification',
  'VideoClustering',
  'VideoMultilabelClassification',
  'VideoPairClassification',
  'VideoZeroshotClassification',
  'VideoCentricQA',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_CATEGORIES = [
  't2t',
  't2c',
  'i2i',
  'i2c',
  'i2t',
  't2i',
  'it2t',
  'it2i',
  'i2it',
  't2it',
  'it2it',
  'a2a',
  'a2c',
  'a2t',
  't2a',
  'at2t',
  'at2i',
  'at2a',
  'a2at',
  't2at',
  'at2at',
  'v2v',
  'v2c',
  'v2t',
  't2v',
  'vt2t',
  'vt2v',
  'v2vt',
  't2vt',
  'vt2vt',
  'va2c',
  'va2t',
  't2va',
  'vat2t',
  'va2va',
  'v2a',
  'a2v',
  'vt2a',
  'it2a',
  'at2v',
  'a2i',
  'i2a',
  'i2v',
  'i2va',
  'it2v',
  'v2i',
  'it2c',
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const ANNOTATOR_TYPES = [
  'expert-annotated',
  'human-annotated',
  'derived',
  'LM-generated',
  'LM-generated and reviewed',
  'automatic',
  'automatic-and-reviewed',
  'algorithmic',
] as const;

export type AnnotatorType = (typeof ANNOTATOR_TYPES)[number];

export const SIMPLIFIED_TASK_TYPES = [
  'retrieval',
  'clustering',
  'classification',
  'semantic-similarity',
  'pair-classification',
] as const;

export type SimplifiedTaskType = (typeof SIMPLIFIED_TASK_TYPES)[number];

export const TASK_TYPE_TO_SIMPLIFIED_TASK_TYPE: Readonly<
  Record<TaskType, SimplifiedTaskType>
> = {
  Any2AnyReranking: 'retrieval',
  Any2AnyRetrieval: 'retrieval',
  Any2AnyMultilingualRetrieval: 'retrieval',
  VisionCentricQA: 'retrieval',
  DocumentUnderstanding: 'retrieval',
  AudioReranking: 'retrieval',
  Reranking: 'retrieval',
  Retrieval: 'retrieval',
  InstructionRetrieval: 'retrieval',
  InstructionReranking: 'retrieval',
  Clustering: 'clustering',
  ImageClustering: 'clustering',
  AudioClustering: 'clustering',
  AudioMultilabelClassification: 'classification',
  AudioZeroshotClassification: 'classification',
  AudioClassification: 'classification',
  ImageClassification: 'classification',
  ZeroShotClassification: 'classification',
  MultilabelClassification: 'classification',
  Classification: 'classification',
  Regression: 'classification',
  'VisualSTS(eng)': 'semantic-similarity',
  'VisualSTS(multi)': 'semantic-similarity',
  STS: 'semantic-similarity',
  Summarization: 'semantic-similarity',
  BitextMining: 'semantic-similarity',
  Compositionality: 'pair-classification',
  AudioPairClassification: 'pair-classification',
  PairClassification: 'pair-classification',
  VideoClassification: 'classification',
  VideoClustering: 'clustering',
  VideoMultilabelClassification: 'classification',
  VideoPairClassification: 'pair-classification',
  VideoZeroshotClassification: 'classification',
  VideoCentricQA: 'retrieval',
};

// pydantic's ValidationError: each field that failed, by its location, and
// why. MTEB's ValidationError is a ValueError; this one is an Error.
export class ValidationError extends Error {
  override readonly name = 'ValidationError';
  readonly errors: readonly { readonly loc: string; readonly msg: string }[];

  constructor(
    title: string,
    errors: readonly { readonly loc: string; readonly msg: string }[],
  ) {
    super(
      `${errors.length} validation error${errors.length === 1 ? '' : 's'} for ${title}\n${errors.map(({ loc, msg }) => `${loc}\n  ${msg}`).join('\n')}`,
    );
    this.errors = errors;
  }
}

// Validates input against a schema, as a pydantic model validates its
// fields, and throws a ValidationError that names the model.
export function validateModel<T>(
  schema: z.ZodType<T>,
  title: string,
  input: unknown,
): T {
  const result = schema.safeParse(input, {
    error: (issue) =>
      issue.input === undefined ? 'Field required' : undefined,
  });
  if (result.success) return result.data;
  throw new ValidationError(
    title,
    result.error.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => ({
            loc: [...issue.path, key].join('.'),
            msg: 'Extra inputs are not permitted',
          }))
        : [{ loc: issue.path.join('.'), msg: issue.message }],
    ),
  );
}

// mteb/types/_string_validators.py StrDate: a date as YYYY-MM-DD. A datetime
// with a zero time is a date too, as pydantic reads it.
export const strDate = z.string().transform((value, context) => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u.exec(
      value,
    );
  const [, year = '', month = '', day = ''] = match ?? [];
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    match === null ||
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Input should be a valid date in the format YYYY-MM-DD',
    });
    return z.NEVER;
  }
  return `${year}-${month}-${day}`;
});

// StrURL: a URL, normalized as pydantic's AnyUrl normalizes it (both follow
// the WHATWG URL standard): "https://example.com" becomes
// "https://example.com/".
export const strUrl = z.string().transform((value, context) => {
  if (URL.canParse(value)) return new URL(value).href;
  context.addIssue({
    code: 'custom',
    message: 'Input should be a valid URL, relative URL without a base',
  });
  return z.NEVER;
});

// mteb/languages/programming_languages.py.
export const PROGRAMMING_LANGS = [
  'python',
  'javascript',
  'typescript',
  'go',
  'ruby',
  'java',
  'php',
  'c',
  'c++',
  'c#',
  'rust',
  'swift',
  'scala',
  'shell',
  'sql',
] as const;

// The ISO 15924 script codes of mteb/languages/iso_15924_to_script.json.
const ISO_15924_SCRIPTS = new Set(
  'Adlm Afak Aghb Ahom Arab Aran Armi Armn Avst Bali Bamu Bass Batk Beng Bhks Blis Bopo Brah Brai Bugi Buhd Cakm Cans Cari Cham Cher Chis Chrs Cirt Copt Cpmn Cprt Cyrl Cyrs Deva Diak Dogr Dsrt Dupl Egyd Egyh Egyp Elba Elym Ethi Gara Geok Geor Glag Gong Gonm Goth Gran Grek Gujr Gukh Guru Hanb Hang Hani Hano Hans Hant Hatr Hebr Hira Hluw Hmng Hmnp Hrkt Hung Inds Ital Jamo Java Jpan Jurc Kali Kana Kawi Khar Khmr Khoj Kitl Kits Knda Kore Kpel Krai Kthi Lana Laoo Latf Latg Latn Leke Lepc Limb Lina Linb Lisu Loma Lyci Lydi Mahj Maka Mand Mani Marc Maya Medf Mend Merc Mero Mlym Modi Mong Moon Mroo Mtei Mult Mymr Nagm Nand Narb Nbat Newa Nkdb Nkgb Nkoo Nshu Ogam Olck Onao Orkh Orya Osge Osma Ougr Palm Pauc Pcun Pelm Perm Phag Phli Phlp Phlv Phnx Plrd Piqd Prti Psin Qaaa Qabx Ranj Rjng Rohg Roro Runr Samr Sara Sarb Saur Sgnw Shaw Shrd Shui Sidd Sidt Sind Sinh Sogd Sogo Sora Soyo Sund Sunu Sylo Syrc Syre Syrj Syrn Tagb Takr Tale Talu Taml Tang Tavt Tayo Telu Teng Tfng Tglg Thaa Thai Tibt Tirh Tnsa Todr Tols Toto Tutg Ugar Vaii Visp Vith Wara Wcho Wole Xpeo Xsux Yezi Yiii Zanb Zinh Zmth Zsye Zsym Zxxx Zyyy Zzzz'.split(
    ' ',
  ),
);

function isProgrammingLanguage(code: string | null): boolean {
  return PROGRAMMING_LANGS.some((language) => language === code);
}

// Checks that a language code such as "eng-Latn" is valid. MTEB looks the
// language up in its table of 7,922 ISO 639-3 codes; this port checks that it
// has the form of one (three lowercase letters).
export function checkLanguageCode(code: string): void {
  if (!code)
    throw new Error(`Invalid language code: '', code must not be empty.`);
  let lang: string | null = null;
  let script: string | null = null;
  const dash = code.indexOf('-');
  if (dash !== -1) {
    lang = code.slice(0, dash);
    script = code.slice(dash + 1);
  } else if (/^\p{Lu}/u.test(code)) script = code;
  else lang = code;
  if (script === 'Code') {
    if (isProgrammingLanguage(lang)) return;
    throw new Error(
      `Programming language ${lang ?? 'None'} is not a valid programming language.`,
    );
  }
  if (
    lang !== null &&
    !/^[a-z]{3}$/u.test(lang) &&
    !isProgrammingLanguage(lang)
  )
    throw new Error(
      `Invalid language code: ${lang}, it is not an ISO 639-3 code`,
    );
  if (script !== null && !ISO_15924_SCRIPTS.has(script))
    throw new Error(
      `Invalid script code: ${script}, it is not an ISO 15924 code`,
    );
}

// All arguments to load the dataset of a task.
export type MetadataDatasetDict = {
  readonly path: string;
  readonly revision: string;
  // The name of the dataset config.
  readonly name?: string | undefined;
  readonly split?: string | undefined;
  readonly trustRemoteCode?: boolean | undefined;
};

// The prompts of a task, for its queries and for its documents.
export type PromptDict = {
  readonly [type in PromptType]?: string | undefined;
};

const taskMetadataSchema = z.strictObject({
  dataset: z.strictObject({
    path: z.string(),
    revision: z.string(),
    name: z.string().optional(),
    split: z.string().optional(),
    trustRemoteCode: z.boolean().optional(),
  }),
  name: z.string(),
  description: z.string(),
  prompt: z
    .union([
      z.string(),
      z.strictObject({
        query: z.string().optional(),
        document: z.string().optional(),
      }),
    ])
    .nullable()
    .default(null),
  type: z.enum(TASK_TYPES),
  modalities: z.array(z.enum(MODALITIES)).default((): Modalities[] => ['text']),
  category: z.enum(TASK_CATEGORIES).nullable().default(null),
  reference: strUrl.nullable().default(null),
  evalSplits: z.array(z.string()).default(() => ['test']),
  evalLangs: z.union([
    z.array(z.string()),
    z.map(z.string(), z.array(z.string())),
  ]),
  mainScore: z.string(),
  date: z.tuple([strDate, strDate]).nullable().default(null),
  domains: z.array(z.enum(TASK_DOMAINS)).nullable().default(null),
  taskSubtypes: z.array(z.enum(TASK_SUBTYPES)).nullable().default(null),
  license: z
    .union([z.enum(LICENSES), strUrl])
    .nullable()
    .default(null),
  annotationsCreators: z.enum(ANNOTATOR_TYPES).nullable().default(null),
  dialect: z.array(z.string()).nullable().default(null),
  sampleCreation: z.enum(SAMPLE_CREATION_METHODS).nullable().default(null),
  bibtexCitation: z.string().nullable().default(null),
  adaptedFrom: z.array(z.string()).nullable().default(null),
  isPublic: z.boolean().default(true),
  contributedBy: z.string().nullable().default(null),
  supersededBy: z.string().nullable().default(null),
  isBeta: z.boolean().default(false),
});

// The fields of a task's metadata, as the constructor of TaskMetadata takes
// them. A field with a default may be left out.
export type TaskMetadataInput = z.input<typeof taskMetadataSchema>;

export type TaskMetadataFields = z.output<typeof taskMetadataSchema>;

// The fields that isFilled() does not require.
const OPTIONAL_FIELDS = new Set<string>([
  'prompt',
  'adaptedFrom',
  'contributedBy',
  'supersededBy',
]);

const CATEGORY_TO_MODALITY: Readonly<Record<string, Modalities>> = {
  t: 'text',
  i: 'image',
  a: 'audio',
  v: 'video',
};

function camelCase(name: string): string {
  return name.replaceAll(/_([a-z])/gu, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

// The input with the defaults of the fields it leaves out, without
// validation.
function withDefaults(input: TaskMetadataInput): TaskMetadataFields {
  return {
    ...input,
    prompt: input.prompt ?? null,
    modalities: input.modalities ?? ['text'],
    category: input.category ?? null,
    reference: input.reference ?? null,
    evalSplits: input.evalSplits ?? ['test'],
    date: input.date ?? null,
    domains: input.domains ?? null,
    taskSubtypes: input.taskSubtypes ?? null,
    license: input.license ?? null,
    annotationsCreators: input.annotationsCreators ?? null,
    dialect: input.dialect ?? null,
    sampleCreation: input.sampleCreation ?? null,
    bibtexCitation: input.bibtexCitation ?? null,
    adaptedFrom: input.adaptedFrom ?? null,
    isPublic: input.isPublic ?? true,
    contributedBy: input.contributedBy ?? null,
    supersededBy: input.supersededBy ?? null,
    isBeta: input.isBeta ?? false,
  };
}

// The metadata of a task: its dataset, its type, its languages, its main
// score and the facts that describe the data.
export class TaskMetadata {
  // All arguments to load the dataset of the task.
  readonly dataset: MetadataDatasetDict;
  readonly name: string;
  readonly description: string;
  readonly prompt: string | PromptDict | null;
  readonly type: TaskType;
  readonly modalities: Modalities[];
  readonly category: TaskCategory | null;
  // A URL of the documentation of the task, such as a paper.
  readonly reference: string | null;
  readonly evalSplits: string[];
  // The languages as "{language}-{script}" codes, or the languages of each
  // HuggingFace subset.
  readonly evalLangs: ISOLanguageScript[] | Map<HFSubset, ISOLanguageScript[]>;
  readonly mainScore: string;
  // When the data was collected: the first and the last day.
  readonly date: [string, string] | null;
  readonly domains: TaskDomain[] | null;
  readonly taskSubtypes: TaskSubtype[] | null;
  // A license name in lowercase, such as "cc-by-nc-4.0", or the URL of a
  // custom license.
  readonly license: Licenses | string | null;
  readonly annotationsCreators: AnnotatorType | null;
  readonly dialect: string[] | null;
  readonly sampleCreation: SampleCreationMethod | null;
  readonly bibtexCitation: string | null;
  // The datasets that the dataset was adapted from.
  readonly adaptedFrom: string[] | null;
  // False when a HuggingFace token is needed to load the dataset.
  readonly isPublic: boolean;
  readonly contributedBy: string | null;
  // The task that replaces this one.
  readonly supersededBy: string | null;
  // The dataset is still being verified and can change.
  readonly isBeta: boolean;

  // Validates the input, as pydantic does. With validate false, it takes the
  // input as it is and fills the defaults (pydantic's model_construct).
  constructor(
    input: TaskMetadataInput,
    options: { readonly validate?: boolean } = {},
  ) {
    const fields =
      options.validate === false
        ? withDefaults(input)
        : validateModel(taskMetadataSchema, 'TaskMetadata', input);
    this.dataset = fields.dataset;
    this.name = fields.name;
    this.description = fields.description;
    this.prompt = fields.prompt;
    this.type = fields.type;
    this.modalities = fields.modalities;
    this.category = fields.category;
    this.reference = fields.reference;
    this.evalSplits = fields.evalSplits;
    this.evalLangs = fields.evalLangs;
    this.mainScore = fields.mainScore;
    this.date = fields.date;
    this.domains = fields.domains;
    this.taskSubtypes = fields.taskSubtypes;
    this.license = fields.license;
    this.annotationsCreators = fields.annotationsCreators;
    this.dialect = fields.dialect;
    this.sampleCreation = fields.sampleCreation;
    this.bibtexCitation = fields.bibtexCitation;
    this.adaptedFrom = fields.adaptedFrom;
    this.isPublic = fields.isPublic;
    this.contributedBy = fields.contributedBy;
    this.supersededBy = fields.supersededBy;
    this.isBeta = fields.isBeta;
  }

  // The metadata from its JSON form (pydantic's model_validate of a
  // model_dump in JSON mode): snake_case keys, and an object of subsets for
  // multilingual languages.
  static fromDict(dict: Readonly<Record<string, unknown>>): TaskMetadata {
    const input = Object.fromEntries(
      Object.entries(dict).map(([key, value]) => {
        if (key === 'dataset' && typeof value === 'object' && value !== null)
          return [
            key,
            Object.fromEntries(
              Object.entries(value).map(([name, field]) => [
                camelCase(name),
                field,
              ]),
            ),
          ];
        if (
          key === 'eval_langs' &&
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value)
        )
          return [camelCase(key), new Map(Object.entries(value))];
        return [camelCase(key), value];
      }),
    );
    return new TaskMetadata(
      validateModel(taskMetadataSchema, 'TaskMetadata', input),
      { validate: false },
    );
  }

  // The JSON form of the metadata, with MTEB's snake_case keys in MTEB's
  // order (pydantic's model_dump in JSON mode).
  toDict(): Record<string, unknown> {
    const { trustRemoteCode, ...dataset } = this.dataset;
    return {
      dataset: {
        ...dataset,
        ...(trustRemoteCode === undefined
          ? {}
          : { trust_remote_code: trustRemoteCode }),
      },
      name: this.name,
      description: this.description,
      prompt: this.prompt,
      type: this.type,
      modalities: this.modalities,
      category: this.category,
      reference: this.reference,
      eval_splits: this.evalSplits,
      eval_langs: isLanguageList(this.evalLangs)
        ? this.evalLangs
        : Object.fromEntries(this.evalLangs),
      main_score: this.mainScore,
      date: this.date,
      domains: this.domains,
      task_subtypes: this.taskSubtypes,
      license: this.license,
      annotations_creators: this.annotationsCreators,
      dialect: this.dialect,
      sample_creation: this.sampleCreation,
      bibtex_citation: this.bibtexCitation,
      adapted_from: this.adaptedFrom,
      is_public: this.isPublic,
      contributed_by: this.contributedBy,
      superseded_by: this.supersededBy,
      is_beta: this.isBeta,
    };
  }

  // A copy with some fields changed. As pydantic's model_copy, it does not
  // validate the changed fields.
  modelCopy(update: Partial<TaskMetadataFields> = {}): TaskMetadata {
    return new TaskMetadata({ ...this, ...update }, { validate: false });
  }

  // A key that is equal for equal metadata (TaskMetadata.__hash__ of MTEB
  // hashes model_dump_json()).
  hashKey(): string {
    return JSON.stringify(this.toDict());
  }

  // The type of the task in five groups, such as "clustering" for both
  // Clustering and ImageClustering.
  get simplifiedTaskType(): SimplifiedTaskType {
    return TASK_TYPE_TO_SIMPLIFIED_TASK_TYPE[this.type];
  }

  // The language and script codes, sorted and without duplicates.
  get bcp47Codes(): ISOLanguageScript[] {
    return pythonSorted(new Set(this.#langLists().flat()));
  }

  // The ISO 639-3 codes of the languages, sorted and without duplicates.
  get languages(): string[] {
    return pythonSorted(
      new Set(
        this.#langLists()
          .flat()
          .map((lang) => lang.split('-', 1)[0] ?? lang),
      ),
    );
  }

  // The ISO 15924 codes of the scripts.
  get scripts(): Set<string> {
    return new Set(
      this.#langLists()
        .flat()
        .map((lang) => {
          const script = lang.split('-')[1];
          if (script === undefined)
            throw new RangeError('list index out of range');
          return script;
        }),
    );
  }

  // True when every field is set, except prompt, adaptedFrom, contributedBy
  // and supersededBy.
  isFilled(): boolean {
    return Object.entries(this).every(
      ([field, value]) => OPTIONAL_FIELDS.has(field) || value !== null,
    );
  }

  // The languages of each HuggingFace subset. A task with one language list
  // has the subset "default".
  get hfSubsetsToLangscripts(): Map<HFSubset, readonly ISOLanguageScript[]> {
    return isLanguageList(this.evalLangs)
      ? new Map([['default', this.evalLangs]])
      : new Map(this.evalLangs);
  }

  // The citation key of bibtexCitation, as \cite{key} when includeCite.
  intextCitation(includeCite = true): string {
    let cite = '';
    if (this.bibtexCitation) {
      const key = this.bibtexCitation.split(',')[0]?.split('{')[1];
      if (key === undefined) throw new RangeError('list index out of range');
      cite = key;
    }
    if (includeCite && cite) return `\\cite{${cite}}`;
    return cite;
  }

  get hfSubsets(): HFSubset[] {
    return [...this.hfSubsetsToLangscripts.keys()];
  }

  get isMultilingual(): boolean {
    return !isLanguageList(this.evalLangs);
  }

  // The revision of the dataset.
  get revision(): string {
    return this.dataset.revision;
  }

  // The modalities of the task, or, with a prompt type and a category, the
  // modalities of the queries or of the documents.
  getModalities(promptType?: PromptType | null): Modalities[] {
    if (
      promptType === undefined ||
      promptType === null ||
      this.category === null
    )
      return [...this.modalities];
    const [queryModalities = '', documentModalities = ''] =
      this.category.split('2');
    const codes = promptType === 'query' ? queryModalities : documentModalities;
    return [...codes].map((code) => {
      const modality = CATEGORY_TO_MODALITY[code];
      if (modality === undefined) throw new Error(`KeyError: '${code}'`);
      return modality;
    });
  }

  #langLists(): (readonly string[])[] {
    return isLanguageList(this.evalLangs)
      ? [this.evalLangs]
      : [...this.evalLangs.values()];
  }
}

// One language list, as opposed to the languages of each subset.
function isLanguageList(
  languages: Languages,
): languages is readonly ISOLanguageScript[] {
  return Array.isArray(languages);
}

// Python's sorted() of strings.
function pythonSorted(values: Iterable<string>): string[] {
  return [...values].sort(compareStrings);
}
