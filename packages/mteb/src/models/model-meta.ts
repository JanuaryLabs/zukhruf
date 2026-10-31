// mteb/models/model_meta.py. Not ported: loading a model (load_model, the
// registry, the extras installer), reading the HuggingFace Hub (from_hub,
// fetch_release_date, the parameter and memory calculations), the
// sentence-transformers constructors, the training-data helpers that need
// the task registry (get_training_datasets, is_zero_shot_on,
// zero_shot_percentage) and the model card helpers.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { EmbeddingModel, RerankingModel } from 'ai';
import { z } from 'zod';

import {
  checkLanguageCode,
  strDate,
  strUrl,
  validateModel,
} from '../abstasks/task-metadata.ts';
import {
  compareStrings,
  isPlainObject,
  pythonFloatRepr,
} from '../dependencies/python.ts';
import type { EncodeKwargs } from '../types/encoder-io.ts';
import { LICENSES, MODALITIES } from '../types/metadata.ts';
import type {
  ISOLanguageScript,
  Licenses,
  Modalities,
} from '../types/metadata.ts';
import type {
  CrossEncoderProtocol,
  EncoderProtocol,
  SearchProtocol,
} from './models-protocols.ts';

export const FRAMEWORKS = [
  'Sentence Transformers',
  'PyTorch',
  'GritLM',
  'LLM2Vec',
  'TensorFlow',
  'JAX',
  'API',
  'Tevatron',
  'NumPy',
  'PyLate',
  'ColBERT',
  'ColPali',
  'GGUF',
  'safetensors',
  'ONNX',
  'OpenVINO',
  'Transformers',
] as const;

export type Framework = (typeof FRAMEWORKS)[number];

export const MODEL_TYPES = [
  'dense',
  'cross-encoder',
  'late-interaction',
  'sparse',
  'router',
  'hybrid',
] as const;

export type ModelType = (typeof MODEL_TYPES)[number];

// The licenses that count as open in the openness score: OSI-approved or
// otherwise free. Non-commercial, no-derivatives and other restricted
// licenses are not in it.
export const OPEN_LICENSES: ReadonlySet<string> = new Set([
  'mit',
  'apache-2.0',
  'bsd-3-clause',
  'gpl-3.0',
  'lgpl',
  'lgpl-3.0',
  'mpl-2.0',
  'afl-3.0',
  'eupl-1.2',
  'cc0-1.0',
  'cc-by-2.0',
  'cc-by-3.0',
  'cc-by-4.0',
  'cc-by-sa-3.0',
  'cc-by-sa-4.0',
  'odc-by',
  'cdla-sharing-1.0',
  'openmdw-1.1',
]);

// The scoring function of a model (the ScoringFunction enum of MTEB).
export const ScoringFunction = {
  COSINE: 'cosine',
  DOT_PRODUCT: 'dot',
  MAX_SIM: 'MaxSim',
  EUCLIDEAN: 'euclidean',
  MANHATTAN: 'manhattan',
  CUSTOM: 'custom',
} as const;

export type ScoringFunctionName =
  (typeof ScoringFunction)[keyof typeof ScoringFunction];

const SCORING_FUNCTIONS = [
  ScoringFunction.COSINE,
  ScoringFunction.DOT_PRODUCT,
  ScoringFunction.MAX_SIM,
  ScoringFunction.EUCLIDEAN,
  ScoringFunction.MANHATTAN,
  ScoringFunction.CUSTOM,
] as const;

// The output and load dtypes of a model, by name (the OutputDType enum of
// mteb/types/_encoder_io.py).
export const OUTPUT_DTYPES = [
  'float32',
  'float16',
  'bfloat16',
  'int8',
  'int4',
  'uint8',
  'uint4',
  'binary',
  'float8_e4m3fn',
  'float8_e5m2',
  'float8_e8m0fnu',
  'float8_e4m3fnuz',
  'float8_e5m2fnuz',
] as const;

export type OutputDType = (typeof OUTPUT_DTYPES)[number];

// The model that a loader makes: an encoder, a cross-encoder or a search
// model.
type MTEBModels = EncoderProtocol | CrossEncoderProtocol | SearchProtocol;

// The keyword arguments of loadModel.
export type LoadKwargs = Readonly<Record<string, unknown>>;

// The keyword arguments of an encoder that an AI SDK embedding model serves
// (MTEB loads the weights itself): the model, then the experiment arguments.
export type EncoderKwargs = LoadKwargs & {
  readonly model: Exclude<EmbeddingModel, string>;
};

// The keyword arguments of a cross-encoder that an AI SDK reranking model
// serves (MTEB loads the weights itself): the model, then the experiment
// arguments.
export type CrossEncoderKwargs = LoadKwargs & {
  readonly model: Exclude<RerankingModel, string>;
};

// The metadata that the model reports. MTEB sets it on the model after the
// loader returns.
export type LoaderContext = { readonly modelMeta: ModelMeta };

// What a loader gets besides the name and the revision of the model.
export type LoaderOptions<Kwargs extends LoadKwargs> = Kwargs & LoaderContext;

// A function that makes the model. Without Kwargs, no call can load the
// model, as MTEB raises for a metadata without a loader.
export type ModelLoader<
  Kwargs extends LoadKwargs = never,
  Model extends MTEBModels = MTEBModels,
> = (
  name: string,
  revision: string | null,
  options: LoaderOptions<Kwargs>,
) => Model;

// A Python int: an integral number.
const int = z.number().int();

// A Python float: pydantic allows infinity and NaN.
const float = z.custom<number>(
  (value) => typeof value === 'number',
  'Input should be a valid number',
);

const FIELD_SCHEMAS = {
  loaderKwargs: z.record(z.string(), z.unknown()).default(() => ({})),
  name: z
    .string()
    .nullable()
    .refine(
      (name) => name === null || name.includes('/'),
      "Value error, Model name must be in the format 'organization/model_name'",
    ),
  revision: z.string().nullable(),
  releaseDate: strDate.nullable(),
  languages: z
    .array(z.string())
    .nullable()
    .superRefine((languages, context) => {
      for (const code of languages ?? []) {
        try {
          checkLanguageCode(code);
        } catch (error) {
          context.addIssue({
            code: 'custom',
            message: `Value error, ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }),
  nParameters: int.nullable(),
  nActiveParametersOverride: int.nullable().default(null),
  nEmbeddingParameters: int.nullable().default(null),
  memoryUsageMb: float.nullable(),
  maxTokens: float.nullable(),
  embedDim: z.union([int, z.array(int)]).nullable(),
  license: z.union([z.enum(LICENSES), strUrl]).nullable(),
  openWeights: z.boolean().nullable(),
  publicTrainingCode: z.string().nullable(),
  publicTrainingData: z.union([z.string(), z.boolean()]).nullable(),
  framework: z.array(z.enum(FRAMEWORKS)),
  reference: strUrl.nullable().default(null),
  similarityFnName: z
    .enum(SCORING_FUNCTIONS, {
      error: (issue) =>
        `Value error, Invalid similarity function name: ${String(issue.input)}`,
    })
    .nullable(),
  useInstructions: z.boolean().nullable(),
  trainingDatasets: z
    .union([z.set(z.string()), z.array(z.string())])
    .transform((datasets) => new Set(datasets))
    .nullable(),
  adaptedFrom: z.string().nullable().default(null),
  supersededBy: z.string().nullable().default(null),
  modalities: z.array(z.enum(MODALITIES)).default((): Modalities[] => ['text']),
  modelType: z.array(z.enum(MODEL_TYPES)).default((): ModelType[] => ['dense']),
  citation: z.string().nullable().default(null),
  contacts: z.array(z.string()).nullable().default(null),
  experimentKwargs: z.record(z.string(), z.unknown()).nullable().default(null),
  outputDtypes: z
    .union([z.enum(OUTPUT_DTYPES), z.array(z.enum(OUTPUT_DTYPES))])
    .nullable()
    .default(null),
  extraRequirementsGroups: z.array(z.string()).nullable().default(null),
};

function modelMetaSchema<
  Kwargs extends LoadKwargs = never,
  Model extends MTEBModels = MTEBModels,
>() {
  return z.strictObject({
    loader: z
      .custom<ModelLoader<Kwargs, Model>>(
        (value) => typeof value === 'function',
      )
      .nullable(),
    ...FIELD_SCHEMAS,
  });
}

// The fields of the metadata of a model, as the constructor of ModelMeta
// takes them. The deprecated isCrossEncoder sets modelType.
export type ModelMetaInput<
  Kwargs extends LoadKwargs = never,
  Model extends MTEBModels = MTEBModels,
> = z.input<ReturnType<typeof modelMetaSchema<Kwargs, Model>>> & {
  readonly isCrossEncoder?: boolean | null;
};

export type ModelMetaFields<
  Kwargs extends LoadKwargs = never,
  Model extends MTEBModels = MTEBModels,
> = z.output<ReturnType<typeof modelMetaSchema<Kwargs, Model>>>;

// The fields in MTEB's order, which is the order of model_meta.json.
const FIELD_NAMES = [
  'loader',
  'loaderKwargs',
  'name',
  'revision',
  'releaseDate',
  'languages',
  'nParameters',
  'nActiveParametersOverride',
  'nEmbeddingParameters',
  'memoryUsageMb',
  'maxTokens',
  'embedDim',
  'license',
  'openWeights',
  'publicTrainingCode',
  'publicTrainingData',
  'framework',
  'reference',
  'similarityFnName',
  'useInstructions',
  'trainingDatasets',
  'adaptedFrom',
  'supersededBy',
  'modalities',
  'modelType',
  'citation',
  'contacts',
  'experimentKwargs',
  'outputDtypes',
  'extraRequirementsGroups',
] as const satisfies readonly (keyof ModelMetaFields)[];

function camelCase(name: string): string {
  return name.replaceAll(/_([a-z])/gu, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

// _handle_legacy_is_cross_encoder of MTEB: the deprecated isCrossEncoder sets
// modelType.
function withoutIsCrossEncoder(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const { isCrossEncoder, ...others } = input;
  const rest: Record<string, unknown> = { ...others };
  if (isCrossEncoder === undefined || isCrossEncoder === null) return rest;
  const current = rest['modelType'];
  const modelType: readonly unknown[] = Array.isArray(current)
    ? current
    : ['dense'];
  if (isCrossEncoder) {
    if (!modelType.includes('cross-encoder'))
      rest['modelType'] = ['cross-encoder'];
  } else if (modelType.includes('cross-encoder')) {
    const kept = modelType.filter((type) => type !== 'cross-encoder');
    rest['modelType'] = kept.length > 0 ? kept : ['dense'];
  }
  return rest;
}

// The input with the defaults of the fields it leaves out, without
// validation.
function withDefaults<Kwargs extends LoadKwargs, Model extends MTEBModels>(
  input: ModelMetaInput<Kwargs, Model>,
): ModelMetaFields<Kwargs, Model> {
  return {
    ...input,
    loaderKwargs: input.loaderKwargs ?? {},
    nActiveParametersOverride: input.nActiveParametersOverride ?? null,
    nEmbeddingParameters: input.nEmbeddingParameters ?? null,
    reference: input.reference ?? null,
    trainingDatasets:
      input.trainingDatasets === null ? null : new Set(input.trainingDatasets),
    adaptedFrom: input.adaptedFrom ?? null,
    supersededBy: input.supersededBy ?? null,
    modalities: input.modalities ?? ['text'],
    modelType: input.modelType ?? ['dense'],
    citation: input.citation ?? null,
    contacts: input.contacts ?? null,
    experimentKwargs: input.experimentKwargs ?? null,
    outputDtypes: input.outputDtypes ?? null,
    extraRequirementsGroups: input.extraRequirementsGroups ?? null,
  };
}

function copyField<Field extends keyof ModelMetaFields>(
  target: ModelMetaFields,
  source: ModelMetaFields,
  field: Field,
): void {
  target[field] = source[field];
}

// The metadata of a model: its name and revision, its similarity function,
// its modalities and the facts that describe it. Kwargs are the keyword
// arguments of loadModel and Model is the model that it returns.
export class ModelMeta<
  Kwargs extends LoadKwargs = never,
  Model extends MTEBModels = MTEBModels,
> {
  readonly loader: ModelLoader<Kwargs, Model> | null;
  readonly loaderKwargs: Record<string, unknown>;
  // The name, as "organization/model_name", ideally the name on HuggingFace.
  readonly name: string | null;
  readonly revision: string | null;
  readonly releaseDate: string | null;
  readonly languages: ISOLanguageScript[] | null;
  readonly nParameters: number | null;
  // For Mixture of Experts models only.
  readonly nActiveParametersOverride: number | null;
  readonly nEmbeddingParameters: number | null;
  readonly memoryUsageMb: number | null;
  readonly maxTokens: number | null;
  // A list is the range of dimensions of a Matryoshka model.
  readonly embedDim: number | number[] | null;
  readonly license: Licenses | string | null;
  readonly openWeights: boolean | null;
  readonly publicTrainingCode: string | null;
  readonly publicTrainingData: string | boolean | null;
  readonly framework: Framework[];
  readonly reference: string | null;
  readonly similarityFnName: ScoringFunctionName | null;
  readonly useInstructions: boolean | null;
  // The MTEB names of the datasets that the model was trained on.
  readonly trainingDatasets: Set<string> | null;
  readonly adaptedFrom: string | null;
  readonly supersededBy: string | null;
  readonly modalities: Modalities[];
  readonly modelType: ModelType[];
  readonly citation: string | null;
  readonly contacts: string[] | null;
  // The parameters of an experiment, such as an ablation. They name the
  // folder of its results (experimentName).
  readonly experimentKwargs: Record<string, unknown> | null;
  readonly outputDtypes: OutputDType | OutputDType[] | null;
  readonly extraRequirementsGroups: string[] | null;

  // Validates the input, as pydantic does. With validate false, it takes the
  // input as it is and fills the defaults (pydantic's model_construct).
  constructor(
    input: ModelMetaInput<Kwargs, Model>,
    options: { readonly validate?: boolean } = {},
  ) {
    const fields =
      options.validate === false
        ? withDefaults(input)
        : validateModel(
            modelMetaSchema<Kwargs, Model>(),
            'ModelMeta',
            withoutIsCrossEncoder(input),
          );
    this.loader = fields.loader;
    this.loaderKwargs = fields.loaderKwargs;
    this.name = fields.name;
    this.revision = fields.revision;
    this.releaseDate = fields.releaseDate;
    this.languages = fields.languages;
    this.nParameters = fields.nParameters;
    this.nActiveParametersOverride = fields.nActiveParametersOverride;
    this.nEmbeddingParameters = fields.nEmbeddingParameters;
    this.memoryUsageMb = fields.memoryUsageMb;
    this.maxTokens = fields.maxTokens;
    this.embedDim = fields.embedDim;
    this.license = fields.license;
    this.openWeights = fields.openWeights;
    this.publicTrainingCode = fields.publicTrainingCode;
    this.publicTrainingData = fields.publicTrainingData;
    this.framework = fields.framework;
    this.reference = fields.reference;
    this.similarityFnName = fields.similarityFnName;
    this.useInstructions = fields.useInstructions;
    this.trainingDatasets = fields.trainingDatasets;
    this.adaptedFrom = fields.adaptedFrom;
    this.supersededBy = fields.supersededBy;
    this.modalities = fields.modalities;
    this.modelType = fields.modelType;
    this.citation = fields.citation;
    this.contacts = fields.contacts;
    this.experimentKwargs = fields.experimentKwargs;
    this.outputDtypes = fields.outputDtypes;
    this.extraRequirementsGroups = fields.extraRequirementsGroups;
  }

  // A metadata with every field empty, then the overwrites, then the name
  // "no_model_name/available" and the revision "no_revision_available" when
  // they are still empty. As in MTEB, the overwrites are not validated.
  static createEmpty(overwrites: Partial<ModelMetaFields> = {}): ModelMeta {
    const empty = new ModelMeta({
      loader: null,
      name: null,
      revision: null,
      releaseDate: null,
      languages: null,
      nParameters: null,
      nEmbeddingParameters: null,
      memoryUsageMb: null,
      maxTokens: null,
      embedDim: null,
      license: null,
      openWeights: null,
      publicTrainingCode: null,
      publicTrainingData: null,
      framework: [],
      reference: null,
      similarityFnName: null,
      useInstructions: null,
      trainingDatasets: null,
      adaptedFrom: null,
      supersededBy: null,
      citation: null,
      contacts: null,
    }).modelCopy(overwrites);
    return empty.modelCopy({
      ...(empty.name === null ? { name: 'no_model_name/available' } : {}),
      ...(empty.revision === null ? { revision: 'no_revision_available' } : {}),
    });
  }

  // The metadata from its JSON form (model_meta.json): snake_case keys, the
  // loader as a name and the deprecated is_cross_encoder. MTEB looks the
  // loader name up in its model registry (model_validate_json_resolved);
  // this port has no registry, so the loader is null.
  static fromDict(dict: Readonly<Record<string, unknown>>): ModelMeta {
    // A loader in a JSON file is the name of a function in MTEB's registry,
    // which this package does not have.
    const input = Object.fromEntries(
      Object.entries(dict).map(([key, value]) => [
        camelCase(key),
        key === 'loader' ? null : value,
      ]),
    );
    return new ModelMeta(
      validateModel(
        modelMetaSchema(),
        'ModelMeta',
        withoutIsCrossEncoder(input),
      ),
      { validate: false },
    );
  }

  // The JSON form, with MTEB's snake_case keys in MTEB's order: the loader as
  // its name, the largest dimension of a Matryoshka model, and
  // is_cross_encoder.
  toDict(): Record<string, unknown> {
    return {
      loader_kwargs: this.loaderKwargs,
      name: this.name,
      revision: this.revision,
      release_date: this.releaseDate,
      languages: this.languages,
      n_parameters: this.nParameters,
      n_active_parameters_override: this.nActiveParametersOverride,
      n_embedding_parameters: this.nEmbeddingParameters,
      memory_usage_mb: this.memoryUsageMb,
      max_tokens: this.maxTokens,
      embed_dim: Array.isArray(this.embedDim)
        ? Math.max(...this.embedDim)
        : this.embedDim,
      license: this.license,
      open_weights: this.openWeights,
      public_training_code: this.publicTrainingCode,
      public_training_data: this.publicTrainingData,
      framework: this.framework,
      reference: this.reference,
      similarity_fn_name: this.similarityFnName,
      use_instructions: this.useInstructions,
      training_datasets:
        this.trainingDatasets === null ? null : [...this.trainingDatasets],
      adapted_from: this.adaptedFrom,
      superseded_by: this.supersededBy,
      modalities: this.modalities,
      model_type: this.modelType,
      citation: this.citation,
      contacts: this.contacts,
      experiment_kwargs: this.experimentKwargs,
      output_dtypes: this.outputDtypes,
      extra_requirements_groups: this.extraRequirementsGroups,
      loader: this.loader?.name ?? null,
      is_cross_encoder: this.isCrossEncoder,
    };
  }

  // The model, through its loader. The keyword arguments with a value, but
  // the AI SDK model of an encoder or a cross-encoder, become the experiment
  // arguments of the copy of the metadata that the model reports, and so
  // name the folder of its results.
  loadModel(
    ...[kwargs]: Record<string, never> extends Kwargs
      ? [kwargs?: Kwargs]
      : [kwargs: Kwargs]
  ): Model {
    if (this.loader === null)
      throw new Error('No model implementation is available for this model.');
    if (this.name === null)
      throw new Error('name is not set for ModelMeta. Cannot load model.');
    const { model, ...rest }: LoadKwargs = kwargs ?? {};
    const merged = { ...this.experimentKwargs, ...rest };
    const meaningful = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => hasMeaningfulValue(value)),
    );
    const loaderKwargs = { ...this.loaderKwargs, ...merged };
    const modelMeta = this.modelCopy({
      experimentKwargs: Object.keys(meaningful).length > 0 ? meaningful : null,
      loaderKwargs,
    });
    // Object.assign skips kwargs when the call leaves them out, which the
    // parameter type allows only for keyword arguments that are all optional.
    return this.loader(
      this.name,
      this.revision,
      Object.assign({}, loaderKwargs, kwargs, { modelMeta }),
    );
  }

  // A copy with some fields changed. As pydantic's model_copy, it does not
  // validate the changed fields.
  modelCopy(
    update: Partial<ModelMetaFields<Kwargs, Model>> = {},
  ): ModelMeta<Kwargs, Model> {
    return new ModelMeta<Kwargs, Model>(
      { ...this, ...update },
      { validate: false },
    );
  }

  // True when the other metadata has the same fields (ModelMeta.__eq__).
  equals(other: ModelMeta): boolean {
    return isDeepStrictEqual({ ...this }, { ...other });
  }

  // A key that is equal for metadata with the same name, revision,
  // experiment and dimension (ModelMeta.__hash__), for use in a Map or Set.
  hashKey(): string {
    return JSON.stringify([
      this.name,
      this.revision,
      this.experimentKwargs ? this.experimentName : null,
      this.embedDim,
    ]);
  }

  get isCrossEncoder(): boolean {
    return this.modelType.includes('cross-encoder');
  }

  // The parameters without the embedding layer, or the override.
  get nActiveParameters(): number | null {
    if (this.nActiveParametersOverride !== null)
      return this.nActiveParametersOverride;
    if (this.nParameters !== null && this.nEmbeddingParameters !== null)
      return this.nParameters - this.nEmbeddingParameters;
    return null;
  }

  // True when the license is one of OPEN_LICENSES.
  get openLicense(): boolean {
    if (this.license === null) return false;
    return OPEN_LICENSES.has(this.license.toLowerCase());
  }

  // How open the model is, in six dimensions after the OSAI index. The
  // "model card" dimension is always true.
  get openness(): Record<string, boolean> {
    return {
      'open weights': this.openWeights === true,
      'open license': this.openLicense,
      'open training code': Boolean(this.publicTrainingCode),
      'open training data': Boolean(this.publicTrainingData),
      paper: Boolean(this.citation),
      'model card': true,
    };
  }

  // The number of openness dimensions that the model meets, from 0 to 6.
  get opennessScore(): number {
    return Object.values(this.openness).filter(Boolean).length;
  }

  // The name as a folder name: "/" becomes "__" and a space becomes "_".
  modelNameAsPath(): string {
    if (this.name === null) throw new Error('Model name is not set');
    return this.name.replaceAll('/', '__').replaceAll(' ', '_');
  }

  // The experiment parameters as a folder name, or null without parameters.
  get experimentName(): string | null {
    return serializeExperimentKwargsToName(this.experimentKwargs);
  }

  // The name with the experiment parameters, such as
  // "org/model (param1=value1)".
  get modelNameWithExperiment(): string | null {
    if (this.name === null) return null;
    const experiment = serializeExperimentKwargsToName(
      this.experimentKwargs,
      '=',
      ', ',
    );
    return experiment ? `${this.name} (${experiment})` : this.name;
  }

  // This metadata with the fields of overwrite that are set. A name or a
  // revision of createEmpty does not overwrite a real one.
  merge(overwrite: ModelMeta): ModelMeta {
    const merged: ModelMetaFields = { ...this };
    for (const field of FIELD_NAMES) {
      if (
        field === 'name' &&
        overwrite.name === 'no_model_name/available' &&
        this.name !== 'no_model_name/available'
      )
        continue;
      if (
        field === 'revision' &&
        overwrite.revision === 'no_revision_available' &&
        this.revision !== 'no_revision_available'
      )
        continue;
      if (field === 'framework')
        merged.framework = [
          ...new Set([...merged.framework, ...overwrite.framework]),
        ];
      if (field === 'modelType')
        merged.modelType = [
          ...new Set([...merged.modelType, ...overwrite.modelType]),
        ];
      // As in MTEB, a list of the overwrite then replaces the combined list.
      if (overwrite[field] !== null) copyField(merged, overwrite, field);
    }
    return new ModelMeta(merged, { validate: false });
  }
}

const INVALID_CHARACTERS = new Set('<>:"|?*\\/\0');

function serializeValue(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    const text =
      value === null
        ? 'None'
        : typeof value === 'boolean'
          ? value
            ? 'True'
            : 'False'
          : typeof value === 'number'
            ? Number.isInteger(value) && !Object.is(value, -0)
              ? BigInt(value).toString()
              : pythonFloatRepr(value)
            : value;
    return [...text]
      .map((character) => (INVALID_CHARACTERS.has(character) ? '_' : character))
      .join('');
  }
  if (Array.isArray(value)) return `[${value.map(serializeValue).join(',')}]`;
  if (value instanceof Map || isPlainObject(value)) {
    const entries = [
      ...(value instanceof Map ? value.entries() : Object.entries(value)),
    ].sort(([a], [b]) => compareStrings(String(a), String(b)));
    return `{${entries.map(([key, item]) => `${String(key)}:${serializeValue(item)}`).join(',')}}`;
  }
  const type =
    typeof value === 'object' && value !== null
      ? value.constructor.name
      : typeof value;
  throw new Error(
    `experiment_kwargs contains non-serializable type ${type}. Only JSON-serializable types (str, int, float, bool, list, dict, None), Enums, numpy arrays, and Pydantic models are supported.`,
  );
}

// The experiment parameters as a deterministic, file-system safe name, such
// as "lr_0.1__pooling_mean". A name longer than 200 characters, or one with a
// character that a path cannot hold, becomes "exp_" and 16 hex digits of its
// sha256 (_serialize_experiment_kwargs_to_name of MTEB). A whole number
// serializes as a Python int: 1.0 gives "1", where MTEB gives "1.0".
export function serializeExperimentKwargsToName(
  experimentKwargs: Readonly<Record<string, unknown>> | null | undefined,
  valueFieldSeparator = '_',
  kwargsSeparator = '__',
): string | null {
  if (
    experimentKwargs === null ||
    experimentKwargs === undefined ||
    Object.keys(experimentKwargs).length === 0
  )
    return null;
  const params = Object.entries(experimentKwargs)
    .sort(([a], [b]) => compareStrings(a, b))
    .map(
      ([key, value]) => `${key}${valueFieldSeparator}${serializeValue(value)}`,
    )
    .join(kwargsSeparator);
  if (
    [...params].length > 200 ||
    [...params].some((character) => INVALID_CHARACTERS.has(character))
  )
    return `exp_${createHash('sha256').update(params).digest('hex').slice(0, 16)}`;
  return params;
}

// Folds the precision encode kwarg into experimentKwargs.outputDtypes:
// precision changes the dtype of the embeddings, so it is part of the
// experiment.
export function mergePrecisionIntoExperimentKwargs(
  experimentKwargs: Readonly<Record<string, unknown>> | null | undefined,
  encodeKwargs: EncodeKwargs,
): Record<string, unknown> {
  const merged = { ...experimentKwargs };
  const { precision } = encodeKwargs;
  if (precision !== undefined) {
    if (!OUTPUT_DTYPES.some((dtype) => dtype === precision))
      throw new Error(
        `'${precision}' is not a valid OutputDType value, must be one of [${OUTPUT_DTYPES.map((dtype) => `'${dtype}'`).join(', ')}]`,
      );
    merged['output_dtypes'] = precision;
  }
  return merged;
}

// _has_meaningful_value: null and empty strings and collections are no-ops.
function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' || Array.isArray(value))
    return value.length > 0;
  if (value instanceof Set || value instanceof Map) return value.size > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}
