import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LeaseController, LeaseLostError } from './index.ts';

describe('LeaseController', () => {
  test('a loss aborts the signal with a LeaseLostError that names the subject and carries the cause', () => {
    // Arrange
    const controller = new LeaseController('orders');
    const { signal } = controller;
    const cause = new Error('The coordinator refused the reassertion.');

    // Act
    controller.lose(cause);

    // Assert
    assert.equal(signal.aborted, true);
    assert.ok(signal.reason instanceof LeaseLostError);
    assert.equal(signal.reason.subject, 'orders');
    assert.equal(signal.reason.cause, cause);
  });

  test('a loss without a cause gives an error that has no cause property', () => {
    // Arrange
    const controller = new LeaseController('orders');

    // Act
    controller.lose();

    // Assert
    assert.ok(controller.signal.reason instanceof LeaseLostError);
    assert.equal(Object.hasOwn(controller.signal.reason, 'cause'), false);
  });

  test('a second loss keeps the reason of the first loss', () => {
    // Arrange
    const controller = new LeaseController('orders');
    const first = new Error('first');
    controller.lose(first);
    const reason: unknown = controller.signal.reason;

    // Act
    controller.lose(new Error('second'));

    // Assert
    assert.equal(controller.signal.reason, reason);
    assert.ok(reason instanceof LeaseLostError);
    assert.equal(reason.cause, first);
  });

  test('a loss after the end never aborts the signal', () => {
    // Arrange
    const controller = new LeaseController('orders');
    controller.end();

    // Act
    controller.lose(new Error('The coordinator refused the reassertion.'));

    // Assert
    assert.equal(controller.signal.aborted, false);
  });

  test('an end, also a second one, keeps the reason of an earlier loss', () => {
    // Arrange
    const controller = new LeaseController('orders');
    controller.lose();
    const reason: unknown = controller.signal.reason;

    // Act
    controller.end();
    controller.end();

    // Assert
    assert.equal(controller.signal.aborted, true);
    assert.equal(controller.signal.reason, reason);
  });
});
