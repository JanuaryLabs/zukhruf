import { Gate } from '../../scorers/gate.ts';
import type { Comparison } from '../comparison/comparison.ts';

// 1 when the case's JSON Schema is a valid schema of its draft, else 0.
export class ValidSchema extends Gate<Comparison> {
  holds({ schema }: Comparison): boolean {
    return schema.valid;
  }

  explain({ schema }: Comparison): string {
    return `the JSON Schema of the case is not a valid schema of draft ${schema.draft}`;
  }
}
