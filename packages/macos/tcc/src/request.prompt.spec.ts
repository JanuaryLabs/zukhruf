import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe } from 'node:test';
import { promisify } from 'node:util';

import { waitFor } from '@zukhruf/testing/async';
import { test } from '@zukhruf/testing/node';

import {
  Accessibility,
  Automation,
  Bluetooth,
  Calendars,
  Camera,
  Contacts,
  FullDiskAccess,
  InputMonitoring,
  Microphone,
  Photos,
  PhotosAdd,
  Reminders,
  ScreenRecording,
  SpeechRecognition,
} from './index.ts';

const run = promisify(execFile);

// These tests need a person at the Mac: macOS shows a prompt for each service
// whose status is not decided, and the person answers it. Allow and Don't
// Allow both decide the status.
describe('a request that a person answers', { concurrency: false }, () => {
  void test.each(
    [
      new Contacts(),
      new Calendars(),
      new Reminders(),
      new Camera(),
      new Microphone(),
      new Photos(),
      new PhotosAdd(),
      new SpeechRecognition(),
      new Bluetooth(),
    ],
    (service) =>
      test(`of ${service.constructor.name} resolves with a decided status`, async (t) => {
        // Act
        const answered = await service.request({ signal: t.signal });

        // Assert
        assert.notEqual(answered, 'notDetermined');
        assert.equal(answered, service.status());
      }),
  );

  void test.each(
    [
      new Accessibility(),
      new ScreenRecording(),
      new InputMonitoring(),
      new Automation('com.apple.finder'),
    ],
    (service) =>
      test(`of ${service.constructor.name} resolves with the status that it then has`, async (t) => {
        // Act
        const answered = await service.request({ signal: t.signal });

        // Assert
        assert.equal(answered, service.status());
      }),
  );
});

describe('the pane of a service', () => {
  test('opens in System Settings', async (t) => {
    // Act
    await new FullDiskAccess().openSettings();

    // Assert
    await waitFor(
      async () => {
        await run('/usr/bin/pgrep', ['-x', 'System Settings']);
      },
      { signal: t.signal, interval: 100 },
    );
  });
});
