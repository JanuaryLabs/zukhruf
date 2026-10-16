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
    '@import "tailwindcss" source(none);\n@import "@zukhruf/shadcn/styles.css";',
    { base: packageDirectory, onDependency() {} },
  );
  const candidates = new Scanner({ sources: compiler.sources }).scan();
  return compiler.build(candidates);
}

/**
 * The name of the innermost `@layer` block that encloses the first match of
 * `rule`, or `undefined` when the rule is in no layer.
 */
function layerOf(css: string, rule: RegExp) {
  const match = rule.exec(css);
  assert.ok(match, `The stylesheet must contain ${rule}`);
  const enclosing: string[] = [];
  let prelude = '';
  for (const character of css.slice(0, match.index)) {
    if (character === '{') {
      enclosing.push(prelude.trim());
      prelude = '';
    } else if (character === '}') {
      enclosing.pop();
      prelude = '';
    } else if (character === ';') {
      prelude = '';
    } else {
      prelude += character;
    }
  }
  const layer = enclosing.findLast((block) => block.startsWith('@layer '));
  return layer?.slice('@layer '.length);
}

describe('the stylesheet of @zukhruf/shadcn', () => {
  test('an app that imports it gets the classes of the components, colored by variables it can override', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.match(
      css,
      /\.bg-primary\s*\{\s*background-color:\s*var\(--(?:color-)?primary\);?\s*\}/,
      'Button uses bg-primary, so the app needs that rule from the package classes',
    );
    assert.match(
      css,
      /:root\s*\{[^}]*--primary:/,
      'The package must define --primary, which an app overrides to theme the components',
    );
  });

  test('it keeps the pointer cursor on buttons and the height cap on dialogs, both in layers that app utilities override', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.equal(
      layerOf(
        css,
        /button:not\(:disabled\),\s*\[role=['"]?button['"]?\]:not\(:disabled\)\s*\{\s*cursor:\s*pointer;?\s*\}/,
      ),
      'base',
    );
    assert.equal(
      layerOf(
        css,
        /\[data-slot=['"]?dialog-content['"]?\]\s*\{\s*max-height:\s*calc\(100dvh - 2rem\);\s*overflow-y:\s*auto;?\s*\}/,
      ),
      'components',
    );
  });

  test('a dark: utility of the components applies under a .dark ancestor, not under the dark color scheme of the system', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.match(
      css,
      /\.dark\\:bg-input\\\/30:is\(\.dark \*\)\s*\{\s*background-color:\s*var\(--input\);?/,
      'Input uses dark:bg-input/30, which must apply inside an element with the .dark class',
    );
    assert.doesNotMatch(
      css,
      /prefers-color-scheme/,
      'Tailwind keys dark: on prefers-color-scheme by default; the .dark class must replace that',
    );
  });
});
