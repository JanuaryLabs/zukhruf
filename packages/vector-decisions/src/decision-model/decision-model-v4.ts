import type {
  Experimental_DecisionModel,
  Experimental_DecisionQuestion,
} from 'ai';

// The AI SDK's Experimental_DecisionModelV4, which `ai` takes but exports
// only inside the union of the models that experimental_decide accepts.
export type DecisionModelV4 = Extract<
  Experimental_DecisionModel,
  { readonly doDecide: unknown }
>;

export type DecisionCallOptions = Parameters<DecisionModelV4['doDecide']>[0];

export type DecisionResult = Awaited<ReturnType<DecisionModelV4['doDecide']>>;

export type DecisionAnswer = DecisionResult['answers'][string];

// The content of instructions and of a criterion: a text or JSON.
export type DecisionInput = NonNullable<
  Experimental_DecisionQuestion['instructions']
>;
