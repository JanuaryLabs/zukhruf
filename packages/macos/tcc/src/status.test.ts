import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { test } from '@zukhruf/testing/node';

import {
  Accessibility,
  Automation,
  Bluetooth,
  Calendars,
  Camera,
  Contacts,
  InputMonitoring,
  Microphone,
  Photos,
  PhotosAdd,
  Reminders,
  ScreenRecording,
  SpeechRecognition,
} from './index.ts';

const run = promisify(execFile);
const index = fileURLToPath(new URL('./index.ts', import.meta.url));

// The oracle: the same framework calls through JXA in osascript, a path that
// shares no code with the package.
const oracle = `ObjC.import('Foundation');
for (const f of ['AVFoundation', 'Photos', 'EventKit', 'Contacts', 'Speech', 'CoreBluetooth', 'CoreGraphics', 'IOKit', 'ApplicationServices']) ObjC.import(f);
const C = (n) => $.NSClassFromString(n);
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('AXIsProcessTrusted', ['bool', []]);
ObjC.bindFunction('IOHIDCheckAccess', ['unsigned int', ['unsigned int']]);
JSON.stringify({
  camera: Number(C('AVCaptureDevice').authorizationStatusForMediaType($.AVMediaTypeVideo)),
  microphone: Number(C('AVCaptureDevice').authorizationStatusForMediaType($.AVMediaTypeAudio)),
  photos: Number(C('PHPhotoLibrary').authorizationStatusForAccessLevel(2)),
  photosAdd: Number(C('PHPhotoLibrary').authorizationStatusForAccessLevel(1)),
  calendars: Number(C('EKEventStore').authorizationStatusForEntityType(0)),
  reminders: Number(C('EKEventStore').authorizationStatusForEntityType(1)),
  contacts: Number(C('CNContactStore').authorizationStatusForEntityType(0)),
  speech: Number(C('SFSpeechRecognizer').authorizationStatus),
  bluetooth: Number(C('CBManager').authorization),
  inputMonitoring: Number($.IOHIDCheckAccess(1)),
  accessibility: $.AXIsProcessTrusted(),
  screenRecording: $.CGPreflightScreenCaptureAccess(),
});`;

async function read(): Promise<Record<string, number | boolean>> {
  const { stdout } = await run('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    oracle,
  ]);
  return JSON.parse(stdout);
}

// Apple's names for the raw values, in the order of the SDK headers.
const avfoundation = ['notDetermined', 'restricted', 'denied', 'authorized'];
const photos = [
  'notDetermined',
  'restricted',
  'denied',
  'authorized',
  'limited',
];
const eventkit = [
  'notDetermined',
  'restricted',
  'denied',
  'fullAccess',
  'writeOnly',
];
const speech = ['notDetermined', 'denied', 'restricted', 'authorized'];

const services = [
  { status: () => new Camera().status(), key: 'camera', names: avfoundation },
  {
    status: () => new Microphone().status(),
    key: 'microphone',
    names: avfoundation,
  },
  { status: () => new Photos().status(), key: 'photos', names: photos },
  { status: () => new PhotosAdd().status(), key: 'photosAdd', names: photos },
  { status: () => new Calendars().status(), key: 'calendars', names: eventkit },
  { status: () => new Reminders().status(), key: 'reminders', names: eventkit },
  {
    status: () => new Contacts().status(),
    key: 'contacts',
    names: avfoundation,
  },
  {
    status: () => new SpeechRecognition().status(),
    key: 'speech',
    names: speech,
  },
  {
    status: () => new Bluetooth().status(),
    key: 'bluetooth',
    names: ['notDetermined', 'restricted', 'denied', 'allowedAlways'],
  },
  {
    status: () => new InputMonitoring().status(),
    key: 'inputMonitoring',
    names: ['granted', 'denied', 'unknown'],
  },
  {
    status: () => new Accessibility().status(),
    key: 'accessibility',
    names: ['notTrusted', 'trusted'],
  },
  {
    status: () => new ScreenRecording().status(),
    key: 'screenRecording',
    names: ['notGranted', 'granted'],
  },
];

describe('the status of a service', () => {
  void test.each(services, ({ status, key, names }) =>
    test(`${key} gives what its framework gives this process`, async () => {
      // Arrange
      const raw = (await read())[key];

      // Act
      const value = status();

      // Assert
      assert.equal(value, names[Number(raw)]);
    }),
  );

  test('the status of Automation is notRunning while its target app does not run', () => {
    // Act
    const value = new Automation('com.example.not-installed').status();

    // Assert
    assert.equal(value, 'notRunning');
  });
});

describe('node:ffi loads only in the calls that need it', () => {
  test('building a remedy writes no ExperimentalWarning', async () => {
    // Arrange
    const program = `import { Client, Contacts } from ${JSON.stringify(index)};
new Contacts().remedy(Client.executable('/usr/local/bin/node'));`;

    // Act
    const { stderr } = await run(process.execPath, [
      '--input-type=module',
      '--eval',
      program,
    ]);

    // Assert
    assert.doesNotMatch(stderr, /ExperimentalWarning/);
  });

  test('the first status writes the ExperimentalWarning once', async () => {
    // Arrange
    const program = `import { Camera, Contacts } from ${JSON.stringify(index)};
new Contacts().status();
new Camera().status();`;

    // Act
    const { stderr } = await run(process.execPath, [
      '--input-type=module',
      '--eval',
      program,
    ]);

    // Assert
    assert.equal(stderr.match(/ExperimentalWarning/g)?.length, 1);
  });

  test('a process that may not use node:ffi gets the error of Node', async () => {
    // Arrange
    const program = `import { Contacts } from ${JSON.stringify(index)};
new Contacts().status();`;

    // Act and assert
    await assert.rejects(
      run(process.execPath, [
        '--permission',
        '--allow-fs-read=*',
        '--input-type=module',
        '--eval',
        program,
      ]),
      ({ stderr }: { stderr: string }) => stderr.includes('ERR_ACCESS_DENIED'),
    );
  });
});
