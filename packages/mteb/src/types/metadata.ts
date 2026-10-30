// mteb/types/_metadata.py.

// A 3-letter ISO 639-3 language code and a 4-letter ISO 15924 script code,
// such as "eng-Latn".
export type ISOLanguageScript = string;

// A 3-letter ISO 639-3 language code, such as "eng".
export type ISOLanguage = string;

// A 4-letter ISO 15924 script code, such as "Latn".
export type ISOScript = string;

// The languages of a task, or of each of its subsets.
export type Languages =
  | readonly ISOLanguageScript[]
  | ReadonlyMap<string, readonly ISOLanguageScript[]>;

export const LICENSES = [
  'not specified',
  'mit',
  'cc-by-2.0',
  'cc-by-3.0',
  'cc-by-4.0',
  'cc-by-sa-3.0',
  'cc-by-sa-4.0',
  'cc-by-nc-3.0',
  'cc-by-nc-4.0',
  'cc-by-nc-sa-3.0',
  'cc-by-nc-sa-4.0',
  'cc-by-nc-nd-4.0',
  'cc-by-nd-4.0',
  'openrail',
  'openrail++',
  'odc-by',
  'afl-3.0',
  'apache-2.0',
  'cc-by-nd-2.1-jp',
  'cc0-1.0',
  'bsd-3-clause',
  'gpl-3.0',
  'lgpl',
  'lgpl-3.0',
  'cdla-sharing-1.0',
  'mpl-2.0',
  'msr-la-nc',
  'multiple',
  'gemma',
  'eupl-1.2',
  'openmdw-1.1',
] as const;

export type Licenses = (typeof LICENSES)[number];

// The name of a model, as on Hugging Face, such as
// "sentence-transformers/all-MiniLM-L6-v2".
export type ModelName = string;

// The revision of a model: a commit hash, or a version string for an API.
export type Revision = string;

export const MODALITIES = ['text', 'image', 'audio', 'video'] as const;

// The package supports text only. The other modalities stay in the type so
// that metadata and result files of MTEB keep their meaning.
export type Modalities = (typeof MODALITIES)[number];
