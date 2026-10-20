import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

/**
 * Builds an app stylesheet the way the Tailwind Vite plugin does: compile with
 * the `url()`s of imported stylesheets rewritten, scan the sources that the
 * stylesheets register, then build from what the scan found. `source(none)`
 * turns off the automatic scan, so only the `@source` of the package's own
 * stylesheet can find its classes.
 */
async function buildAppStylesheet() {
  const compiler = await compile(
    '@import "tailwindcss" source(none);\n@import "@zukhruf/diagram/styles.css";',
    { base: packageDirectory, shouldRewriteUrls: true, onDependency() {} },
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

  test('an app that imports it gets the Geist Sans and Geist Mono faces that the diagram measures text with', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(
      ([, body = '']) => ({
        family: /font-family:\s*'([^']+)'/.exec(body)?.[1],
        weight: /font-weight:\s*(\d+)/.exec(body)?.[1],
        woff2: /url\(([^)]+\.woff2)\)/.exec(body)?.[1],
      }),
    );
    assert.deepEqual(
      faces.map(({ family, weight }) => `${family} ${weight}`),
      [
        'Geist Sans 400',
        'Geist Sans 500',
        'Geist Sans 600',
        'Geist Sans 700',
        'Geist Mono 400',
        'Geist Mono 500',
        'Geist Mono 600',
        'Geist Mono 700',
      ],
      'Every face and weight in the glyph-width table needs its @font-face',
    );
    for (const { family, weight, woff2 } of faces) {
      assert.ok(woff2, `${family} ${weight} has no woff2 source`);
      const file = fileURLToPath(new URL(woff2, `file://${packageDirectory}`));
      assert.ok(
        existsSync(file),
        `${family} ${weight} loads ${woff2}, which resolves to the missing file ${file}`,
      );
    }
  });
});
