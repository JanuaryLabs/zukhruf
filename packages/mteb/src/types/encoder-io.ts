// mteb/types/_encoder_io.py. Python's HuggingFace datasets become arrays of
// rows, and its dicts become Maps: a Map keeps insertion order for every key,
// as a Python dict does, while an object moves integer-like keys first.

// The keyword arguments of the encode methods.
export type EncodeKwargs = {
  readonly batchSize?: number;
  readonly showProgressBar?: boolean;
  // The quantization of the embeddings, for encoders that support it.
  readonly precision?: string;
};

// The embeddings of a batch of inputs: one float32 row for each input. MTEB
// gives numpy arrays or torch tensors of float32 to its similarity functions.
export type Embeddings = readonly Float32Array[];

// Separates queries from documents for retrieval models.
export type PromptType = 'query' | 'document';

export type ConversationTurn = {
  readonly role: string;
  readonly content: string;
};

export type Conversation = readonly ConversationTurn[];

// The input of an encoder for text.
export type TextInput = {
  readonly text: readonly string[];
};

// The input of an encoder for a retrieval corpus. text is the title and the
// body joined.
export type CorpusInput = TextInput & {
  readonly title: readonly string[];
  readonly body: readonly string[];
};

// The input of an encoder for queries. text is the query and its
// instruction, as the task combines them.
export type QueryInput = TextInput & {
  readonly query: readonly string[];
  readonly conversation?: readonly Conversation[];
  readonly instruction?: readonly string[];
};

// One batch of inputs. MTEB also has image, audio and video inputs; they join
// this union when the package supports a modality other than text.
export type BatchedInput = TextInput | CorpusInput | QueryInput;

// A row of a retrieval corpus.
export type CorpusRow = {
  readonly id: string;
  readonly text: string;
  readonly title?: string;
};

// A row of the queries of a retrieval task.
export type QueryRow = {
  readonly id: string;
  readonly text: string | Conversation;
  readonly instruction?: string;
};

export type CorpusDatasetType = readonly CorpusRow[];

export type QueryDatasetType = readonly QueryRow[];

// For each query id, the relevance of each judged document id.
export type RelevantDocumentsType = ReadonlyMap<
  string,
  ReadonlyMap<string, number>
>;

// For each query id, the ids of its candidate documents, best first.
export type TopRankedDocumentsType = ReadonlyMap<string, readonly string[]>;

// For each query id, the score of each document that the search returned.
export type RetrievalOutputType = Map<string, Map<string, number>>;
