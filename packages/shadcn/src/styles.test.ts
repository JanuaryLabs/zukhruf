import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildAppStylesheet } from './testing/build-app-stylesheet.ts';

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

  test('the components place their ends by logical side, so a right-to-left page mirrors them', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.match(
      css,
      /\.pe-8\s*\{\s*padding-inline-end:\s*calc\(var\(--spacing\) \* 8\);?\s*\}/,
      'The native select pads the end that holds its chevron with pe-8, written by the RTL mode of the shadcn CLI',
    );
    assert.match(
      css,
      /\.end-2\\\.5\s*\{\s*inset-inline-end:\s*calc\(var\(--spacing\) \* 2\.5\);?\s*\}/,
      'The chevron of the native select sits at end-2.5, not at right-2.5',
    );
    assert.doesNotMatch(
      css,
      /\.right-2\\\.5\s*\{/,
      'A component with right-2.5 would keep its chevron on the right in Arabic',
    );
  });

  test('a menu shortcut takes its direction from its own text, in a layer that app utilities override', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.equal(
      layerOf(
        css,
        /\[data-slot=['"]?dropdown-menu-shortcut['"]?\]\s*\{\s*unicode-bidi:\s*plaintext;?\s*\}/,
      ),
      'components',
      'direction: ltr would turn its ms-auto into a left margin in Arabic and move the shortcut next to the label',
    );
  });

  test('a horizontal tabs list with flex-wrap takes the height of its rows, in the layer of the utility it beats', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.equal(
      layerOf(
        css,
        /\[data-slot=['"]?tabs-list['"]?\]\[data-orientation=['"]?horizontal['"]?\]\.flex-wrap\s*\{\s*height:\s*auto;?\s*\}/,
      ),
      'utilities',
      'In an earlier layer the rule loses to group-data-horizontal/tabs:h-8, and the wrapped row overlaps what follows',
    );
  });

  // happy-dom 20 drops each rule in a @layer block from getComputedStyle, so
  // these tests check the cascade inputs: the layer and the order of each rule.
  test('a host theme in @layer base that loads after the stylesheet wins over the default theme', async () => {
    // Arrange: OpenAI's ChatGPT tokens are a host theme of this kind
    // (@openai/mcp-extensions/styles.css).
    const hostTheme = '@layer base { :root { --background: #123456; } }';

    // Act
    const css = await buildAppStylesheet(hostTheme);

    // Assert
    const defaultTheme = /:root\s*\{[^}]*--background:/;
    const host = /:root\s*\{\s*--background:\s*#123456;?\s*\}/;
    assert.equal(
      layerOf(css, defaultTheme),
      'base',
      'A default outside of a layer wins over each rule in a layer, so the host theme would lose',
    );
    assert.equal(layerOf(css, host), 'base');
    assert.ok(
      defaultTheme.exec(css)!.index < host.exec(css)!.index,
      'In one layer, the later rule wins, so the default must come before the host theme',
    );
  });

  test('the .dark defaults follow the :root defaults in the same layer, so the .dark class switches the theme', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    const light = /:root\s*\{[^}]*--background:/;
    const dark = /\.dark\s*\{[^}]*--background:/;
    assert.equal(layerOf(css, light), 'base');
    assert.equal(layerOf(css, dark), 'base');
    assert.ok(
      light.exec(css)!.index < dark.exec(css)!.index,
      ':root and .dark have the same specificity, so .dark must come later to win',
    );
  });
});
