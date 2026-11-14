// The request and the answers of DecisionService.decide, with Venn's names
// in camelCase (venn/server.py:912).

type Kinds = {
  readonly text: string;
  readonly vector: readonly number[];
  readonly texts: readonly string[];
  readonly vectors: readonly (readonly number[])[];
};

// A state of one kind, without the fields of the other kinds.
type OfKind<K extends keyof Kinds> = Pick<Kinds, K> & {
  readonly [Other in Exclude<keyof Kinds, K>]?: never;
};

// A text that the reader embeds, or a vector, or a plural state: several
// texts or vectors, each one a row that IndexApply answers.
export type State =
  | string
  | OfKind<'text'>
  | OfKind<'vector'>
  | OfKind<'texts'>
  | OfKind<'vectors'>;

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

export type Question =
  ChoiceQuestion | ScoreQuestion | NoulQuestion | IndexApplyQuestion;

// A question that registerQuestion prepared, by its handle. The registered
// question gives the rest.
export type QuestionRef = {
  readonly questionRef: string;
  readonly threshold?: number;
  readonly rowCap?: number;
  readonly batchSize?: number;
};

export type DecisionRequest = {
  readonly state: State;
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

// The answer of a Choice about one row, and the index of the row.
export type RowAnswer = ChoiceAnswer & { readonly id: number };

export type IndexApplyAnswer = {
  readonly rows: readonly RowAnswer[];
  // The count of batches of batchSize rows.
  readonly batches: number;
};

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer | IndexApplyAnswer;

export type Decision = {
  readonly answers: Readonly<Record<string, Answer>>;
  // The vector of a state that the reader embedded, the rows of a state of
  // texts, else null.
  readonly vector: readonly number[] | readonly (readonly number[])[] | null;
};
