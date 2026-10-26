import assert from 'node:assert/strict';
import { test } from 'node:test';

import spawn from 'nano-spawn';

import { Environment } from './environment.ts';

test('a set that names a key of an open scope throws, names the key, and changes nothing', () => {
  const environment = new Environment();
  using _held = environment.set({ ZUKHRUF_TESTING_HELD: 'first' });

  assert.throws(
    () =>
      environment.set({
        ZUKHRUF_TESTING_FREE: 'second',
        ZUKHRUF_TESTING_HELD: 'second',
      }),
    /ZUKHRUF_TESTING_HELD/,
  );

  assert.equal(process.env.ZUKHRUF_TESTING_HELD, 'first');
  assert.equal(Object.hasOwn(process.env, 'ZUKHRUF_TESTING_FREE'), false);
  using free = environment.set({ ZUKHRUF_TESTING_FREE: 'third' });
  assert.equal(process.env.ZUKHRUF_TESTING_FREE, 'third');
});

test('a key that was absent is deleted at restore', () => {
  const scope = new Environment().set({ ZUKHRUF_TESTING_ABSENT: 'value' });
  assert.equal(process.env.ZUKHRUF_TESTING_ABSENT, 'value');

  scope.cleanup();

  assert.equal(Object.hasOwn(process.env, 'ZUKHRUF_TESTING_ABSENT'), false);
});

test('a key that held an empty string holds it again after restore', () => {
  process.env.ZUKHRUF_TESTING_EMPTY = '';
  try {
    const scope = new Environment().set({ ZUKHRUF_TESTING_EMPTY: 'value' });

    scope.cleanup();

    assert.equal(process.env.ZUKHRUF_TESTING_EMPTY, '');
  } finally {
    delete process.env.ZUKHRUF_TESTING_EMPTY;
  }
});

test('undefined deletes the key for the scope, and restore gives its earlier value', () => {
  process.env.ZUKHRUF_TESTING_DELETED = 'earlier';
  try {
    const scope = new Environment().set({ ZUKHRUF_TESTING_DELETED: undefined });
    assert.equal(Object.hasOwn(process.env, 'ZUKHRUF_TESTING_DELETED'), false);

    scope.cleanup();

    assert.equal(process.env.ZUKHRUF_TESTING_DELETED, 'earlier');
  } finally {
    delete process.env.ZUKHRUF_TESTING_DELETED;
  }
});

test('the keys of a disposed scope are free for a new set', () => {
  const environment = new Environment();
  {
    using _first = environment.set({ ZUKHRUF_TESTING_REUSED: 'first' });
  }

  using second = environment.set({ ZUKHRUF_TESTING_REUSED: 'second' });

  assert.equal(process.env.ZUKHRUF_TESTING_REUSED, 'second');
});

test('a child process that starts in the scope sees its values', async () => {
  using _scope = new Environment().set({ ZUKHRUF_TESTING_CHILD: 'inherited' });

  const child = await spawn(process.execPath, [
    '--print',
    'process.env.ZUKHRUF_TESTING_CHILD',
  ]);

  assert.equal(child.stdout, 'inherited');
});

test('TZ in a scope changes the time zone of dates, and restore changes it back', () => {
  const offset = () => new Date(0).getTimezoneOffset();
  const before = offset();
  const zone = before === -330 ? 'Asia/Tokyo' : 'Asia/Kolkata';
  const expected = zone === 'Asia/Tokyo' ? -540 : -330;
  const scope = new Environment().set({ TZ: zone });

  assert.equal(offset(), expected);
  scope.cleanup();

  assert.equal(offset(), before);
});
