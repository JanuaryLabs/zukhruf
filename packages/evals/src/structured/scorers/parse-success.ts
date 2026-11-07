import type { Comparison } from '../comparison/comparison.ts';
import { Gate } from './gate.ts';

// 1 when the stated value is a JSON object or array, else 0.
export class ParseSuccess extends Gate {
  holds({ parsed }: Comparison): boolean {
    return parsed;
  }

  explain(): string {
    return 'the stated value is not a JSON object or array';
  }
}
