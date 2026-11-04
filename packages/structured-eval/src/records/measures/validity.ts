import type { OutputUnit, ValidationResult } from '@cfworker/json-schema';

import { Ratio } from '../../aggregation/ratio.ts';
import type { Measure, NamedRatio } from '../measure.ts';

// cfworker reports each failed keyword, also the keywords that only hold a
// failed child (properties, items, $ref …). The reason names the others.
const containers = new Set([
  'properties',
  'patternProperties',
  'additionalProperties',
  'items',
  'prefixItems',
  'additionalItems',
  'contains',
  'allOf',
  'anyOf',
  'oneOf',
  '$ref',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
]);

// A union schema fails once in each branch, so the reason shows the first
// errors only.
const shown = 5;

const line = ({ instanceLocation, error }: OutputUnit) =>
  `${instanceLocation.replace(/^#/, '') || '/'} ${error}`;

// The stated record agrees with the JSON Schema of the spec: `valid` is 1 or
// 0, with weight 1.
export class Validity implements Measure {
  readonly valid: boolean;
  readonly #errors: readonly OutputUnit[];

  constructor(result: ValidationResult) {
    this.valid = result.valid;
    this.#errors = result.errors.filter(
      (error) => !containers.has(error.keyword),
    );
  }

  get reason(): string {
    if (this.valid) return '';
    const lines = [...new Set(this.#errors.map(line))];
    const more =
      lines.length > shown ? ` and ${lines.length - shown} more` : '';
    return `the record does not agree with the schema: ${lines.slice(0, shown).join(', ')}${more}`;
  }

  *ratios(): Generator<NamedRatio> {
    yield ['valid', new Ratio(this.valid ? 1 : 0, 1)];
  }
}
