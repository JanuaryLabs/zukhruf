import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createClock } from '@sinonjs/fake-timers';

// React DOM and Base UI check for a DOM when they load, so each test loads
// them after it registers the DOM.

test('a button with no ClockProvider above it throws at its first render, also when it never loads', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { TheButton } = await import('@zukhruf/ui');
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    try {
      // Act and assert
      await assert.rejects(async () => {
        await act(async () => {
          root.render(createElement(TheButton, {}, 'Save'));
        });
      }, /ClockProvider/);
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('a component below a ClockProvider reads the time from the clock of the provider', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { ClockProvider, useClock } = await import('@zukhruf/ui');
    const clock = createClock(1234);
    const Now = () => String(useClock().Date.now());
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    try {
      // Act
      await act(async () => {
        root.render(
          createElement(ClockProvider, {
            clock,
            children: createElement(Now),
          }),
        );
      });

      // Assert
      assert.equal(container.textContent, '1234');
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('while loading, the spinner shows only after the delay, and each new load waits for the delay again', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { ClockProvider, TheButton } = await import('@zukhruf/ui');
    const clock = createClock();
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    // Happy DOM runs no CSS, so the opacity class of the wrapper of the
    // spinner tells whether it shows.
    const spinnerShows = () =>
      document
        .querySelector('svg.animate-spin')
        ?.parentElement?.classList.contains('opacity-100');
    const render = (loading: boolean) =>
      act(async () => {
        root.render(
          createElement(ClockProvider, {
            clock,
            children: createElement(
              TheButton,
              { loading, delay: 1000 },
              'Save',
            ),
          }),
        );
      });
    try {
      // Act
      await render(true);
      const atStart = spinnerShows();
      await act(() => clock.tickAsync(999));
      const beforeDelay = spinnerShows();
      await act(() => clock.tickAsync(1));
      const afterDelay = spinnerShows();
      await render(false);
      const afterLoad = spinnerShows();
      await render(true);
      const atNextStart = spinnerShows();
      await render(false);

      // Assert
      assert.deepEqual(
        { atStart, beforeDelay, afterDelay, afterLoad, atNextStart },
        {
          atStart: false,
          beforeDelay: false,
          afterDelay: true,
          afterLoad: false,
          atNextStart: false,
        },
      );
      assert.equal(clock.countTimers(), 0);
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('a loading button is disabled, and the same button is enabled when it stops loading', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { ClockProvider, TheButton } = await import('@zukhruf/ui');
    const clock = createClock();
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    try {
      // Act
      await act(async () => {
        root.render(
          createElement(ClockProvider, {
            clock,
            children: createElement(TheButton, { loading: true }, 'Save'),
          }),
        );
      });
      const disabledWhileLoading = document.querySelector('button')?.disabled;
      await act(async () => {
        root.render(
          createElement(ClockProvider, {
            clock,
            children: createElement(TheButton, { loading: false }, 'Save'),
          }),
        );
      });

      // Assert
      assert.equal(disabledWhileLoading, true);
      assert.equal(document.querySelector('button')?.disabled, false);
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('a button with a tooltip shows the tooltip text on focus, and stays one button', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { ClockProvider, TheButton } = await import('@zukhruf/ui');
    const clock = createClock();
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    try {
      await act(async () => {
        root.render(
          createElement(ClockProvider, {
            clock,
            children: createElement(
              TheButton,
              { tooltip: 'Open settings' },
              'Settings',
            ),
          }),
        );
      });

      const openBeforeFocus = document.querySelector(
        '[data-slot="tooltip-content"]',
      );

      // Act
      await act(async () => {
        document.querySelector('button')?.focus();
      });

      // Assert
      assert.equal(openBeforeFocus, null);
      const buttons = document.querySelectorAll('button');
      assert.equal(buttons.length, 1);
      assert.match(buttons[0]?.textContent ?? '', /Settings/);
      assert.equal(
        document.querySelector('[data-slot="tooltip-content"]')?.textContent,
        'Open settings',
      );
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('a Lucide icon component given as the icon draws its svg', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Trash } = await import('lucide-react');
    const { ClockProvider, TheButton } = await import('@zukhruf/ui');
    const clock = createClock();
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    try {
      // Act
      await act(async () => {
        root.render(
          createElement(ClockProvider, {
            clock,
            children: createElement(TheButton, { icon: Trash }, 'Delete'),
          }),
        );
      });

      // Assert
      assert.ok(document.querySelector('button svg.lucide-trash'));
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});
