import { Gate } from '../../scorers/gate.ts';
import type { Comparison } from '../comparison/comparison.ts';

// 1 when the stated value is a JSON object or array, else 0.
export class ParseSuccess extends Gate<Comparison> {
  holds({ parsed }: Comparison): boolean {
    return parsed;
  }

  explain(): string {
    return 'the stated value is not a JSON object or array';
  }
}
