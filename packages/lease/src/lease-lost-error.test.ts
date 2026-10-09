import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LeaseLostError } from './index.ts';

describe('LeaseLostError', () => {
  test('is an Error named LeaseLostError whose message quotes the subject', () => {
    // Arrange
    const subject = 'orders "eu"';

    // Act
    const error = new LeaseLostError(subject);

    // Assert
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'LeaseLostError');
    assert.equal(error.subject, subject);
    assert.equal(
      error.message,
      'Lost the lease on "orders \\"eu\\"": another holder may have it now.',
    );
  });
});
