import assert from 'node:assert/strict';
import { describe } from 'node:test';

import { test } from '@zukhruf/testing/node';

import { Camera, Contacts, SpeechRecognition } from './index.ts';

describe('a request', () => {
  void test.each(
    [new Camera(), new Contacts(), new SpeechRecognition()],
    (service) =>
      test(`of ${service.constructor.name} with an aborted signal rejects with its reason and asks nothing`, async () => {
        // Arrange
        const controller = new AbortController();
        const reason = new Error('the caller stopped');
        controller.abort(reason);

        // Act and assert
        await assert.rejects(
          service.request({ signal: controller.signal }),
          (error) => error === reason,
        );
      }),
  );
});
