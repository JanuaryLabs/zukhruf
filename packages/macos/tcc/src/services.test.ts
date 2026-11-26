import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe } from 'node:test';
import { promisify } from 'node:util';

import { test } from '@zukhruf/parameterized-test';

import {
  Accessibility,
  Automation,
  Bluetooth,
  Calendars,
  Camera,
  Client,
  Contacts,
  FullDiskAccess,
  InputMonitoring,
  Microphone,
  Photos,
  PhotosAdd,
  Reminders,
  ScreenRecording,
  type Service,
  SpeechRecognition,
} from './index.ts';

const run = promisify(execFile);

// System Settings of this Mac is the oracle: its Privacy & Security extension
// holds the pane titles, the anchors and the TCC services that it shows.
const extension =
  '/System/Library/ExtensionKit/Extensions/SecurityPrivacyExtension.appex/Contents/Resources';

async function plist(path: string): Promise<unknown> {
  // The string table of System Settings is larger than the 1 MiB default.
  const { stdout } = await run(
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', path],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function titles(): Promise<Record<string, string>> {
  const table = await plist(`${extension}/Localizable.loctable`);
  assert.ok(table !== null && typeof table === 'object' && 'en' in table);
  const english = table.en;
  assert.ok(english !== null && typeof english === 'object');
  return Object.fromEntries(
    Object.entries(english).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

// The search terms of System Settings for each anchor, in lower case.
async function anchors(): Promise<Map<string, string>> {
  const terms = await plist(
    `${extension}/en.lproj/PrivacySecurity.searchTerms`,
  );
  assert.ok(terms !== null && typeof terms === 'object');
  return new Map(
    Object.entries(terms).map(([anchor, entry]) => [
      anchor,
      JSON.stringify(entry).toLowerCase(),
    ]),
  );
}

async function listed(): Promise<Map<string, string>> {
  const list = await plist(`${extension}/TCCServiceList.plist`);
  assert.ok(Array.isArray(list));
  const pairs = new Map<string, string>();
  for (const entry of list)
    if (
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.tcc === 'string' &&
      typeof entry.revealElementKeyName === 'string'
    )
      pairs.set(entry.tcc, entry.revealElementKeyName);
  return pairs;
}

const services: readonly { service: Service; title: string }[] = [
  { service: new FullDiskAccess(), title: 'ALL_FILES' },
  { service: new Contacts(), title: 'CONTACTS' },
  { service: new Calendars(), title: 'CALENDARS' },
  { service: new Reminders(), title: 'REMINDERS' },
  { service: new Camera(), title: 'CAMERA' },
  { service: new Microphone(), title: 'MICROPHONE' },
  { service: new Photos(), title: 'PHOTOS' },
  { service: new PhotosAdd(), title: 'PHOTOS' },
  { service: new SpeechRecognition(), title: 'SPEECH_RECOGNITION' },
  { service: new Bluetooth(), title: 'BLUETOOTH' },
  { service: new InputMonitoring(), title: 'LISTEN_EVENT' },
  { service: new Accessibility(), title: 'ACCESSIBILITY' },
  { service: new ScreenRecording(), title: 'SCREEN_CAPTURE' },
  { service: new Automation('com.apple.Finder'), title: 'AUTOMATION' },
];

describe('each service names its pane as System Settings does', () => {
  void test.each(services, ({ service, title }) =>
    test(`${service.constructor.name} has the pane title of System Settings`, async () => {
      // Arrange
      const shown = await titles();

      // Act and assert
      assert.equal(service.pane, shown[title]);
    }),
  );

  void test.each(
    services.filter(({ service }) => !(service instanceof FullDiskAccess)),
    ({ service }) =>
      test(`the remedy of ${service.constructor.name} names the client and the pane`, () => {
        // Arrange
        const client = Client.bundle('/Applications/cmux.app');

        // Act
        const remedy = service.remedy(client);

        // Assert
        assert.equal(
          remedy,
          `Turn on cmux in System Settings › Privacy & Security › ${service.pane}.`,
        );
      }),
  );

  void test.each(services, ({ service }) =>
    test(`${service.constructor.name} opens a pane that System Settings knows`, async () => {
      // Arrange
      const known = await anchors();

      // Act
      const url = service.url;

      // Assert
      assert.equal(
        `${url.protocol}${url.pathname}`,
        'x-apple.systempreferences:com.apple.preference.security',
      );
      assert.ok(known.has(url.search.slice(1)), url.href);
    }),
  );

  void test.each(services, ({ service }) =>
    test(`${service.constructor.name} has the TCC name of its pane`, async () => {
      // Arrange
      const pairs = await listed();
      const { stdout } = await run('/usr/bin/strings', [
        '/System/Library/PrivateFrameworks/TCC.framework/Support/tccd',
      ]);

      // Act and assert
      assert.ok(stdout.split('\n').includes(service.name), service.name);
      // The panes that TCCServiceList.plist defines by data pair a tcc with an
      // anchor. The panes of a Swift class (Camera, Photos) are paired by none,
      // so their anchor must be one whose search terms name the service: the
      // first word of its pane, or its TCC name without kTCCService.
      const anchor = service.url.search.slice(1);
      const paired = pairs.get(service.name);
      if (paired !== undefined) assert.equal(anchor, paired);
      else {
        const terms = (await anchors()).get(anchor);
        assert.ok(terms !== undefined, anchor);
        const [word] = service.pane.toLowerCase().split(' ');
        assert.ok(word !== undefined);
        const suffix = service.name.replace('kTCCService', '').toLowerCase();
        assert.ok(terms.includes(word) || terms.includes(suffix), anchor);
      }
    }),
  );
});

describe('the remedy of Full Disk Access', () => {
  test('tells the user to quit and reopen a bundle', () => {
    // Act
    const remedy = new FullDiskAccess().remedy(
      Client.bundle('/Applications/cmux.app'),
    );

    // Assert
    assert.equal(
      remedy,
      'Turn on cmux in System Settings › Privacy & Security › Full Disk Access, then quit and reopen cmux. macOS does not ask for this access.',
    );
  });

  test('tells the user to start an executable again', () => {
    // Arrange
    const node = '/Users/me/.nvm/versions/node/v26.13.1/bin/node';

    // Act
    const remedy = new FullDiskAccess().remedy(Client.executable(node));

    // Assert
    assert.equal(
      remedy,
      `Turn on ${node} in System Settings › Privacy & Security › Full Disk Access, then start it again. macOS does not ask for this access.`,
    );
  });
});

describe('Full Disk Access', () => {
  test('has no status and no request', () => {
    // Arrange
    const service = new FullDiskAccess();

    // Act and assert
    // @ts-expect-error: macOS gives Full Disk Access no status (ADR 0003).
    assert.equal(service.status, undefined);
    // @ts-expect-error: macOS shows no prompt for Full Disk Access.
    assert.equal(service.request, undefined);
  });
});
