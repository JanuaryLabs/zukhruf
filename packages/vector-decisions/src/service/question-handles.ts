import { hash } from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ContractError } from './contract-error.ts';
import type { OptionQuestion, QuestionRef, StreamedRef } from './decision.ts';

// The fields of a question that a questionRef can give (venn/server.py:955).
const OVERRIDES = new Set(['questionRef', 'threshold', 'rowCap', 'batchSize']);

// The questions that registerQuestion prepared, by their handle, as Venn's
// DecisionService.questions holds them (venn/server.py:854-867, 951-957).
export class QuestionHandles {
  readonly #questions = new Map<string, OptionQuestion>();

  // The handle of a question: the SHA-256 of the question without its
  // threshold, in the canonical JSON of RFC 8785. The same question gets the
  // same handle.
  register(question: OptionQuestion): string {
    const { threshold: _, ...definition } = structuredClone(question);
    const handle = hash('sha256', canonicalJson(definition));
    this.#questions.set(handle, definition);
    return handle;
  }

  // The registered question of a questionRef of decide, with the
  // threshold, the row cap and the batch size of the questionRef.
  question(reference: QuestionRef): OptionQuestion {
    const question = this.#registered(reference.questionRef);
    if (Object.keys(reference).some((field) => !OVERRIDES.has(field)))
      throw new ContractError(
        'prewarm_override',
        'Re-register changed options or instructions',
      );
    return { ...question, ...QuestionHandles.#overrides(reference) };
  }

  // The registered question of a questionRef of streamIndex, and each field
  // of the questionRef over it: Venn's stream_index takes every key
  // (venn/server.py:878-879). The options and the instructions stay the
  // registered ones, as Venn streams the prepared question of the handle.
  streamed(reference: StreamedRef): {
    readonly question: OptionQuestion;
    readonly merged: OptionQuestion & Omit<StreamedRef, 'questionRef'>;
  } {
    const question = this.#registered(reference.questionRef);
    return {
      question,
      merged: { ...question, ...QuestionHandles.#overrides(reference) },
    };
  }

  #registered(handle: string): OptionQuestion {
    const question = this.#questions.get(handle);
    if (question === undefined)
      throw new ContractError(
        'question_handle',
        'Missing or stale question handle',
        404,
      );
    return question;
  }

  static #overrides<R extends QuestionRef>(
    reference: R,
  ): Omit<R, 'questionRef'> {
    const { questionRef: _, ...overrides } = reference;
    return overrides;
  }
}
