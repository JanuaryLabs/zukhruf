// The request and the answers of DecisionService.decide, with Venn's names
// in camelCase (venn/server.py:912).

// A text that the reader embeds, a vector, or several texts.
export type State =
  | string
  | { readonly text: string }
  | { readonly vector: readonly number[] }
  | { readonly texts: readonly string[] };

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
};

export type ChoiceQuestion = Asked & { readonly type?: 'Choice' };

export type ScoreQuestion = Asked & {
  readonly type: 'Score';
  // The score of each option, in order. The default is 0, 1, 2 and so on.
  readonly scores?: readonly number[];
};

export type NoulQuestion = Asked & { readonly type: 'Noul' };

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export type DecisionRequest = {
  readonly state: State;
  readonly questions: Readonly<Record<string, Question>>;
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

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type Decision = {
  readonly answers: Readonly<Record<string, Answer>>;
  // The vector of a state that the reader embedded, else null.
  readonly vector: readonly number[] | null;
};
