import {
  type Experimental_DecisionQuestion,
  Experimental_DecisionUnsupportedQuestionTypeError,
  InvalidArgumentError,
  UnsupportedFunctionalityError,
} from 'ai';

import type { DecisionService } from '../service/decision-service.ts';
import type { ChoiceQuestion } from '../service/decision.ts';
import { BooleanTranslation } from './boolean-translation.ts';
import { ChoiceTranslation } from './choice-translation.ts';
import type {
  DecisionAnswer,
  DecisionCallOptions,
  DecisionModelV4,
  DecisionResult,
} from './decision-model-v4.ts';
import { jsonText } from './json-text.ts';
import { ScoreTranslation } from './score-translation.ts';
import type { Translation } from './translation.ts';

// An AI SDK decision model over a DecisionService, as Venn's Decisions API
// answers over its own (venn/decisions.py:131). Venn gives it as an HTTP
// route.
export class DecisionServiceModel implements DecisionModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'vector-decisions.decision';
  readonly modelId = 'venn-1';
  readonly supportedQuestionTypes: DecisionModelV4['supportedQuestionTypes'] = [
    'choice',
    'score',
    'boolean',
  ];
  readonly #service: DecisionService;

  constructor(service: DecisionService) {
    this.#service = service;
  }

  async doDecide({
    state,
    questions,
    maxOutputTokens,
    reasoning,
  }: DecisionCallOptions): Promise<DecisionResult> {
    const text = DecisionServiceModel.#text(state);
    const translations = new Map<string, Translation>();
    const asked = new Map<string, ChoiceQuestion>();
    for (const [id, question] of Object.entries(questions)) {
      const translation = this.#translation(id, question);
      translations.set(id, translation);
      asked.set(id, translation.question);
    }
    const decision = await this.#service.decide({
      state: text,
      questions: Object.fromEntries(asked),
    });
    const answers = new Map<string, DecisionAnswer>();
    const noneProbability = new Map<string, number>();
    for (const [id, translation] of translations) {
      const { answer, none } = translation.answer(decision.answers[id]);
      answers.set(id, answer);
      noneProbability.set(id, none);
    }
    return {
      answers: Object.fromEntries(answers),
      providerMetadata: {
        vectorDecisions: {
          noneProbability: Object.fromEntries(noneProbability),
        },
      },
      // The head writes no tokens and does not reason.
      warnings: Object.entries({ maxOutputTokens, reasoning }).flatMap(
        ([feature, value]): DecisionResult['warnings'] =>
          value === undefined ? [] : [{ type: 'unsupported', feature }],
      ),
    };
  }

  // The text of a state, which the reader embeds: the text of each part,
  // with "\n" between them, as the AI SDK's provider of Jev's API joins
  // them (@ai-sdk/typesafe-ai 3.0.40). Venn refuses media parts
  // (venn/decisions.py:62).
  static #text(state: DecisionCallOptions['state']): string {
    return state
      .map((part) => {
        switch (part.type) {
          case 'text':
            return part.text;
          case 'json':
            return jsonText(part.value);
          case 'file':
            throw new UnsupportedFunctionalityError({
              functionality: `Decision file input: ${part.mediaType}`,
            });
        }
      })
      .join('\n');
  }

  #translation(
    id: string,
    question: Experimental_DecisionQuestion,
  ): Translation {
    const instructions = DecisionServiceModel.#instructions(id, question);
    switch (question.type) {
      case 'choice':
        return new ChoiceTranslation(id, instructions, question.criteria);
      case 'score':
        return new ScoreTranslation(id, instructions, question.criteria);
      case 'boolean':
        return new BooleanTranslation(id, instructions, question.criteria);
      case 'box':
        throw new Experimental_DecisionUnsupportedQuestionTypeError({
          questionId: id,
          questionType: question.type,
          provider: this.provider,
          modelId: this.modelId,
        });
    }
  }

  // Venn refuses a question without instructions (venn/decisions.py:91-93).
  static #instructions(
    id: string,
    question: Experimental_DecisionQuestion,
  ): string {
    const { instructions } = question;
    if (instructions === undefined || instructions === null)
      throw new InvalidArgumentError({
        parameter: `questions.${id}.instructions`,
        value: question,
        message: 'Questions require instructions, as Venn does.',
      });
    return jsonText(instructions);
  }
}
