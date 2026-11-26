import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe } from 'node:test';
import { promisify } from 'node:util';

import { test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';

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

// These tests need a person at the Mac. Each one says the status that it
// needs; `tccutil reset <service> <bundle id of the terminal app>` makes a
// service not determined again.
describe('a request that a person answers', { concurrency: false }, () => {
  void test.each([new SpeechRecognition(), new Bluetooth()], (service) =>
    test(`of ${service.constructor.name} shows the prompt, and the answer decides the status`, async (t) => {
      // Arrange
      assert.equal(service.status(), 'notDetermined', service.name);

      // Act
      const answered = await service.request({ signal: t.signal });

      // Assert
      assert.notEqual(answered, 'notDetermined');
      assert.equal(answered, service.status());
    }),
  );

  void test.each(
    [
      new Contacts(),
      new Calendars(),
      new Reminders(),
      new Camera(),
      new Microphone(),
      new Photos(),
      new PhotosAdd(),
      new Accessibility(),
      new ScreenRecording(),
      new InputMonitoring(),
      new Automation('com.apple.finder'),
    ],
    (service) =>
      test(`of ${service.constructor.name} that is decided shows nothing and keeps its status`, async (t) => {
        // Arrange
        const before = service.status();
        assert.notEqual(before, 'notDetermined', service.name);

        // Act
        const answered = await service.request({ signal: t.signal });

        // Assert
        assert.equal(answered, before);
      }),
  );
});

describe('the pane of a service', () => {
  test('opens System Settings', async (t) => {
    // Arrange
    await run('/usr/bin/osascript', ['-e', 'quit app "System Settings"']);
    await waitFor(
      async () => {
        await assert.rejects(run('/usr/bin/pgrep', ['-x', 'System Settings']));
      },
      { signal: t.signal, interval: 100 },
    );

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
