import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RefCount } from './ref-count.ts';

/** A real handle of the event loop that tells whether it is ref'd: a timer that never fires in a test. */
function idleTimer(): NodeJS.Timeout {
  const timer = setInterval(() => {}, 3_600_000);
  timer.unref();
  return timer;
}

describe('RefCount', () => {
  test('a hold refs the handle, and the handle stays ref’d until the last of two holds is disposed, which unrefs it', () => {
    // Arrange
    const timer = idleTimer();
    try {
      const refs = new RefCount(timer);

      // Act
      const first = refs.hold();
      const second = refs.hold();
      const whileBoth = timer.hasRef();
      first[Symbol.dispose]();
      const whileOne = timer.hasRef();
      second[Symbol.dispose]();

      // Assert
      assert.deepEqual(
        { whileBoth, whileOne, afterBoth: timer.hasRef() },
        { whileBoth: true, whileOne: true, afterBoth: false },
      );
    } finally {
      clearInterval(timer);
    }
  });

  test('a second dispose of one hold counts nothing: the other hold keeps the handle ref’d', () => {
    // Arrange
    const timer = idleTimer();
    try {
      const refs = new RefCount(timer);
      const first = refs.hold();
      using _second = refs.hold();

      // Act
      first[Symbol.dispose]();
      first[Symbol.dispose]();

      // Assert
      assert.equal(timer.hasRef(), true);
    } finally {
      clearInterval(timer);
    }
  });

  test('the constructor leaves the handle as it is, ref’d or unref’d', () => {
    // Arrange
    const unrefd = idleTimer();
    const refd = setInterval(() => {}, 3_600_000);
    try {
      // Act
      new RefCount(unrefd);
      new RefCount(refd);

      // Assert
      assert.deepEqual(
        { unrefd: unrefd.hasRef(), refd: refd.hasRef() },
        { unrefd: false, refd: true },
      );
    } finally {
      clearInterval(unrefd);
      clearInterval(refd);
    }
  });
});
