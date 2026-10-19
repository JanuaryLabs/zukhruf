import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

/**
 * Builds an app stylesheet the way the Tailwind CLI does: compile, scan the
 * sources that the stylesheets register, then build from what the scan found.
 * `source(none)` turns off the automatic scan, so only the `@source` of the
 * package's own stylesheet can find its classes.
 */
async function buildAppStylesheet() {
  const compiler = await compile(
    '@import "tailwindcss" source(none);\n@import "@zukhruf/diagram/styles.css";',
    { base: packageDirectory, onDependency() {} },
  );
  const candidates = new Scanner({ sources: compiler.sources }).scan();
  return compiler.build(candidates);
}

describe('the stylesheet of @zukhruf/diagram', () => {
  test('an app that imports it gets the --dgm-* theme variables and the classes that read them', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.match(
      css,
      /\.\\\[--dgm-bg\\:\\#ffffff\\\]\s*\{\s*--dgm-bg:\s*#ffffff;?\s*\}/,
      'The diagram frame sets --dgm-bg, so the app needs that rule from the package classes',
    );
    assert.match(
      css,
      /\.bg-\\\[var\\\(--dgm-bg\\\)\\\]\s*\{\s*background-color:\s*var\(--dgm-bg\);?\s*\}/,
      'The diagram frame paints its background from --dgm-bg',
    );
    assert.match(
      css,
      /\.\\\[--dgm-dim\\:rgba\\\(15\\,23\\,42\\,0\\\.44\\\)\\\]\s*\{\s*--dgm-dim:\s*rgba\(15,\s*23,\s*42,\s*0\.44\);?\s*\}/,
      'The diagram frame sets --dgm-dim, so dim text has a color',
    );
    assert.match(
      css,
      /\.text-\\\[var\\\(--dgm-dim\\\)\\\]\s*\{\s*color:\s*var\(--dgm-dim\);?\s*\}/,
      'Dim diagram text reads --dgm-dim, which the package defines',
    );
  });
});
