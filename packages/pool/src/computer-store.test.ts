import assert from 'node:assert/strict';
import { join } from 'node:path';

import { test } from '@zukhruf/parameterized-test';

import { computerStore } from './index.ts';

const macOS = { skip: process.platform === 'darwin' ? false : 'macOS only' };
const windows = {
  skip: process.platform === 'win32' ? false : 'Windows only',
};
const xdg = {
  skip:
    process.platform === 'darwin' || process.platform === 'win32'
      ? 'Linux and the other XDG systems only'
      : false,
};

test(
  'on macOS the store is in Application Support of the HOME that env gives',
  macOS,
  () => {
    // Arrange
    const env = { HOME: '/Users/another-user' };

    // Act
    const store = computerStore(env);

    // Assert
    assert.equal(
      store,
      join(
        '/Users/another-user',
        'Library',
        'Application Support',
        'zukhruf-pool',
        'store.sqlite',
      ),
    );
  },
);

test('on macOS a missing HOME throws', macOS, () => {
  // Arrange
  const env = { XDG_STATE_HOME: '/state', LOCALAPPDATA: 'C:\\Local' };

  // Act and Assert
  assert.throws(() => computerStore(env), { message: '$HOME is not defined' });
});

test('on an XDG system the store is in XDG_STATE_HOME', xdg, () => {
  // Arrange
  const env = { HOME: '/home/another-user', XDG_STATE_HOME: '/var/state' };

  // Act
  const store = computerStore(env);

  // Assert
  assert.equal(store, join('/var/state', 'zukhruf-pool', 'store.sqlite'));
});

test(
  'on an XDG system an unset or empty XDG_STATE_HOME means HOME/.local/state',
  xdg,
  () => {
    // Arrange
    const expected = join(
      '/home/another-user',
      '.local',
      'state',
      'zukhruf-pool',
      'store.sqlite',
    );

    // Act
    const unset = computerStore({ HOME: '/home/another-user' });
    const empty = computerStore({
      HOME: '/home/another-user',
      XDG_STATE_HOME: '',
    });

    // Assert
    assert.equal(unset, expected);
    assert.equal(empty, expected);
  },
);

test(
  'on an XDG system a missing HOME with no XDG_STATE_HOME throws',
  xdg,
  () => {
    // Arrange
    const env = { LOCALAPPDATA: '/local' };

    // Act and Assert
    assert.throws(() => computerStore(env), {
      message: '$HOME is not defined',
    });
  },
);

test('on Windows the store is in LOCALAPPDATA', windows, () => {
  // Arrange
  const env = { LOCALAPPDATA: 'D:\\Users\\another-user\\AppData\\Local' };

  // Act
  const store = computerStore(env);

  // Assert
  assert.equal(
    store,
    join(
      'D:\\Users\\another-user\\AppData\\Local',
      'zukhruf-pool',
      'store.sqlite',
    ),
  );
});

test('on Windows a missing LOCALAPPDATA throws', windows, () => {
  // Arrange
  const env = { HOME: 'C:\\Users\\another-user' };

  // Act and Assert
  assert.throws(() => computerStore(env), {
    message: '%LOCALAPPDATA% is not defined',
  });
});
