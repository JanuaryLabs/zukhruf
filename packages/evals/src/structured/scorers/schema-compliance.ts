import { Gate } from '../../scorers/gate.ts';
import type { Comparison } from '../comparison/comparison.ts';
import { ParseSuccess } from './parse-success.ts';
import { ValidSchema } from './valid-schema.ts';

// 1 when the stated value is parsed and agrees with a valid schema, else 0.
// Its explanation names the schema errors.
export class SchemaCompliance extends Gate<Comparison> {
  static readonly #parsed = new ParseSuccess();
  static readonly #validSchema = new ValidSchema();

  // A union schema fails once in each branch, so the explanation shows the
  // first errors only.
  static readonly #shown = 5;

  holds({ compliant }: Comparison): boolean {
    return compliant;
  }

  explain(comparison: Comparison): string {
    for (const gate of [
      SchemaCompliance.#parsed,
      SchemaCompliance.#validSchema,
    ])
      if (!gate.holds(comparison)) return gate.explain(comparison);
    const { errors } = comparison.validation;
    const more =
      errors.length > SchemaCompliance.#shown
        ? ` and ${errors.length - SchemaCompliance.#shown} more`
        : '';
    return `the record does not agree with the schema: ${errors.slice(0, SchemaCompliance.#shown).join(', ')}${more}`;
  }
}
