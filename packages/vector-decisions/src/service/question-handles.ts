import { hash } from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ContractError } from './contract-error.ts';
import type { Question, QuestionRef } from './decision.ts';

// The fields of a question that a questionRef can give (venn/server.py:955).
const OVERRIDES = new Set(['questionRef', 'threshold', 'rowCap', 'batchSize']);

// The questions that registerQuestion prepared, by their handle, as Venn's
// DecisionService.questions holds them (venn/server.py:854-867, 951-957).
export class QuestionHandles {
  readonly #questions = new Map<string, Question>();

  // The handle of a question: the SHA-256 of the question without its
  // threshold, in the canonical JSON of RFC 8785. The same question gets the
  // same handle.
  register(question: Question): string {
    const { threshold: _, ...definition } = structuredClone(question);
    const handle = hash('sha256', canonicalJson(definition));
    this.#questions.set(handle, definition);
    return handle;
  }

  // The registered question of a questionRef, with the threshold, the row
  // cap and the batch size of the questionRef.
  question(reference: QuestionRef): Question {
    const { questionRef, ...overrides } = reference;
    const question = this.#questions.get(questionRef);
    if (question === undefined)
      throw new ContractError(
        'question_handle',
        'Missing or stale question handle',
        404,
      );
    if (Object.keys(reference).some((field) => !OVERRIDES.has(field)))
      throw new ContractError(
        'prewarm_override',
        'Re-register changed options or instructions',
      );
    return { ...question, ...overrides };
  }
}
