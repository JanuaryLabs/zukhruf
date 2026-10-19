import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GlobalRegistrator } from '@happy-dom/global-registrator';

test('SIDEBAR_COOKIE_NAME is the name of the cookie that SidebarProvider writes', async () => {
  // Arrange: React DOM and Base UI check for a DOM when they load, so they
  // load after the DOM exists.
  GlobalRegistrator.register({ url: 'http://localhost/' });
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { SIDEBAR_COOKIE_NAME, Sidebar, SidebarProvider, SidebarTrigger } =
      await import('@zukhruf/shadcn');
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );

    try {
      await act(async () => {
        root.render(
          createElement(
            SidebarProvider,
            null,
            createElement(Sidebar, null, 'Links'),
            createElement(SidebarTrigger),
          ),
        );
      });

      // Act
      await act(async () => {
        document
          .querySelector<HTMLElement>('[data-slot="sidebar-trigger"]')
          ?.click();
      });

      // Assert
      const names = document.cookie
        .split(';')
        .map((cookie) => cookie.split('=')[0]?.trim());
      assert.ok(
        names.length > 0 && names[0] !== '',
        'The trigger must make SidebarProvider write a cookie',
      );
      assert.ok(
        names.includes(SIDEBAR_COOKIE_NAME),
        `SidebarProvider wrote ${document.cookie}, not ${SIDEBAR_COOKIE_NAME}`,
      );
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});
