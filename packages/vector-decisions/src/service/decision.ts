// The request and the answers of DecisionService.decide, with Venn's names
// in camelCase (venn/server.py:912).

type Kinds = {
  readonly text: string;
  readonly vector: readonly number[];
  readonly texts: readonly string[];
  readonly vectors: readonly (readonly number[])[];
  readonly indexRef: string;
};

// A state of one kind, without the fields of the other kinds.
type OfKind<K extends keyof Kinds> = Pick<Kinds, K> & {
  readonly [Other in Exclude<keyof Kinds, K>]?: never;
};

// The rows of an index that registerIndex registered, by its handle.
export type IndexState = OfKind<'indexRef'>;

// A text that the reader embeds, or a vector, or a plural state: several
// texts or vectors, or an index, each one a row that IndexApply answers.
export type State =
  | string
  | OfKind<'text'>
  | OfKind<'vector'>
  | OfKind<'texts'>
  | OfKind<'vectors'>
  | IndexState;

// The id of a row of an index, and an outcome: a string or a whole number.
// Venn takes any JSON. A number of JavaScript cannot keep Python's 1 and
// 1.0 apart, so Venn's JSON text and str() of a fraction are out of reach.
export type IndexValue = string | number;

// A text that the reader embeds, or a label with its vector. An option
// without a vector is the text of its label.
export type Option =
  string | { readonly label: string; readonly vector?: readonly number[] };

type Instructions =
  | { readonly instructions?: string; readonly instructionsVec?: never }
  | {
      readonly instructionsVec: readonly number[];
      readonly instructions?: never;
    };

type Asked = Instructions & {
  readonly options: readonly Option[];
  readonly threshold?: number;
  // The family whose temperature divides the logits of the question, when
  // registerCalibration fitted one for its type. The default is the family
  // of the request, else "".
  readonly family?: string;
  readonly questionRef?: never;
};

export type ChoiceQuestion = Asked & { readonly type?: 'Choice' };

export type ScoreQuestion = Asked & {
  readonly type: 'Score';
  // The score of each option, in order. The default is 0, 1, 2 and so on.
  readonly scores?: readonly number[];
};

export type NoulQuestion = Asked & { readonly type: 'Noul' };

// A Choice question about each row of a plural state.
export type IndexApplyQuestion = Asked & {
  readonly type: 'IndexApply';
  // The count of rows to answer, from the first: 0 to 512. The default is
  // all the rows.
  readonly rowCap?: number;
  // The count of rows in a batch: 1 to 65,536 (the default).
  readonly batchSize?: number;
};

// Which outcome: the outcome of the nearest rows of a labelled index
// (venn/server.py:964-986).
export type NearestReferenceQuestion = {
  readonly type: 'NearestReference';
  // The handle of a labelled index of registerIndex.
  readonly indexRef: string;
  // The count of evidence ids: 1 to 100. The default is 5.
  readonly k?: number;
  readonly threshold?: number;
  readonly family?: string;
  readonly questionRef?: never;
};

// A question whose head answers from options and instructions: the types
// that registerQuestion prepares.
export type OptionQuestion =
  ChoiceQuestion | ScoreQuestion | NoulQuestion | IndexApplyQuestion;

export type Question = OptionQuestion | NearestReferenceQuestion;

// A question that registerQuestion prepared, by its handle. The registered
// question gives the rest.
export type QuestionRef = {
  readonly questionRef: string;
  readonly threshold?: number;
  readonly rowCap?: number;
  readonly batchSize?: number;
};

// A question that registerQuestion prepared, for streamIndex: Venn's
// stream_index also takes the family of the questionRef
// (venn/server.py:878-879, 889).
export type StreamedRef = QuestionRef & { readonly family?: string };

export type DecisionRequest = {
  readonly state: State;
  // The family of each question that names none.
  readonly family?: string;
  readonly questions: Readonly<Record<string, Question | QuestionRef>>;
};

export type ChoiceAnswer = {
  // A label, or "none".
  readonly answer: string;
  // The probability of each label, then of "none".
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly calibrated: false;
};

export type ScoreAnswer = ChoiceAnswer & {
  readonly expectedScore: number | null;
  readonly scoreConditionedOnNotNone: true;
};

export type NoulAnswer = Omit<ChoiceAnswer, 'answer'> & {
  readonly answer: 'none' | 'in_scope';
};

// The answer of a Choice about one row, and the id of the row: its index in
// a plural state, or its id in an index.
export type RowAnswer = ChoiceAnswer & { readonly id: IndexValue };

export type IndexApplyAnswer = {
  readonly rows: readonly RowAnswer[];
  // The count of batches of batchSize rows.
  readonly batches: number;
};

// The answers of one batch of streamIndex: the rows from `offset`.
export type IndexBatch = {
  readonly offset: number;
  readonly rows: readonly RowAnswer[];
};

export type NearestReferenceAnswer = {
  // The label of the outcome, as Python's str() writes it, or "none".
  readonly answer: string;
  // The probability of the label, then of "none".
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly calibrated: false;
  // The ids of the k rows of the largest scores, from the largest.
  readonly evidenceIds: readonly IndexValue[];
  // The best score of the label less the best score of another label.
  readonly margin: number;
  readonly noneSemantics: 'cannot affirm nearest outcome; not calibrated corpus-wide OOD';
};

export type Answer =
  | ChoiceAnswer
  | ScoreAnswer
  | NoulAnswer
  | IndexApplyAnswer
  | NearestReferenceAnswer;

export type Decision = {
  readonly answers: Readonly<Record<string, Answer>>;
  // The vector of a state that the reader embedded, the rows of a state of
  // texts, else null.
  readonly vector: readonly number[] | readonly (readonly number[])[] | null;
};
