import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

/** Builds an app stylesheet the way the Tailwind CLI does (see styles.test.ts). */
async function buildAppStylesheet() {
  const compiler = await compile(
    '@import "tailwindcss" source(none);\n@import "@zukhruf/shadcn/styles.css";',
    { base: packageDirectory, onDependency() {} },
  );
  const candidates = new Scanner({ sources: compiler.sources }).scan();
  return compiler.build(candidates);
}

test('the height cap of the stylesheet selects the content of an open Dialog', async () => {
  // Arrange: the selector of the cap comes from the stylesheet that an app
  // builds. React DOM and Base UI check for a DOM when they load, so they load
  // after the DOM exists. The server renderer cannot show the content, because
  // Base UI mounts the portal of a dialog only in a browser.
  const css = await buildAppStylesheet();
  const cap =
    /([^{};]+)\{\s*max-height:\s*calc\(100dvh - 2rem\);\s*overflow-y:\s*auto;?\s*\}/.exec(
      css,
    );
  assert.ok(cap?.[1], 'The stylesheet must cap the height of a dialog');
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Dialog, DialogContent, DialogTitle } =
      await import('@zukhruf/shadcn');
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );

    try {
      // Act
      await act(async () => {
        root.render(
          createElement(
            Dialog,
            { open: true },
            createElement(
              DialogContent,
              null,
              createElement(DialogTitle, null, 'Title'),
            ),
          ),
        );
      });

      // Assert
      const content = document.querySelector(cap[1].trim());
      assert.ok(
        content,
        `The cap selector ${cap[1].trim()} must match the open dialog`,
      );
      assert.equal(
        content.querySelector('[data-slot="dialog-title"]')?.textContent,
        'Title',
      );
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});
