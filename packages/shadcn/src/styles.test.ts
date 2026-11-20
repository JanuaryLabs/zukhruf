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

  test('a select popup pads its inline sides by the 1px border of its trigger, in a layer that app utilities override', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.equal(
      layerOf(
        css,
        /\[data-slot=['"]?select-content['"]?\]\s*\{\s*padding-inline:\s*1px;?\s*\}/,
      ),
      'components',
      'Without the 1px the item text starts 1px before the trigger text, and alignItemWithTrigger moves the popup 1px off the trigger',
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

  test('a host sets the height of the controls with --control-height, with the 32px of nova as the fallback', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    const height =
      /\[data-slot=['"]?input['"]?\]\.h-8,\s*\[data-slot=['"]?input-group['"]?\]\.h-8:not\(\s*:has\(\s*>\s*textarea,\s*>\s*\[data-align=['"]?block-start['"]?\],\s*>\s*\[data-align=['"]?block-end['"]?\]\s*\)\s*\),\s*\[data-slot=['"]?select-trigger['"]?\]\[data-size=['"]?default['"]?\]\.data-\\\[size\\=default\\\]\\:h-8,\s*\.group\\\/button\.h-8:not\(\[data-size\]\)\s*\{\s*height:\s*var\(--control-height,\s*calc\(var\(--spacing\) \* 8\)\);?\s*\}/;
    assert.equal(
      layerOf(css, height),
      'utilities',
      'In an earlier layer the patch loses to the h-8 utility of the component',
    );
  });

  test('a textarea and the chips of a combobox take --control-height as their minimum height', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.equal(
      layerOf(
        css,
        /\[data-slot=['"]?textarea['"]?\]\.min-h-16\s*\{\s*min-height:\s*var\(--control-height,\s*calc\(var\(--spacing\) \* 16\)\);?\s*\}/,
      ),
      'utilities',
    );
    assert.equal(
      layerOf(
        css,
        /\[data-slot=['"]?combobox-chips['"]?\]\.min-h-8\s*\{\s*min-height:\s*var\(--control-height,\s*calc\(var\(--spacing\) \* 8\)\);?\s*\}/,
      ),
      'utilities',
    );
  });

  test('a small button takes --control-height-sm, and a button of an input group keeps its own size', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.equal(
      layerOf(
        css,
        /\.group\\\/button\.h-7:not\(\[data-size\]\)\s*\{\s*height:\s*var\(--control-height-sm,\s*calc\(var\(--spacing\) \* 7\)\);?\s*\}/,
      ),
      'utilities',
      'InputGroupButton writes data-size; without :not([data-size]) its buttons would grow to the control height',
    );
  });

  test('a host sets the background of the controls with --control-background, transparent by default and left to the disabled state', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.equal(
      layerOf(
        css,
        /\[data-slot=['"]?input['"]?\]\.bg-transparent:not\(:disabled\),\s*\[data-slot=['"]?textarea['"]?\]\.bg-transparent:not\(:disabled\),\s*\[data-slot=['"]?select-trigger['"]?\]\.bg-transparent,\s*\[data-slot=['"]?combobox-chips['"]?\]\.bg-transparent\s*\{\s*background-color:\s*var\(--control-background,\s*transparent\);?\s*\}/,
      ),
      'utilities',
    );
    assert.equal(
      layerOf(
        css,
        /:where\(\[data-slot=['"]?input-group['"]?\]\)\s*\{\s*background-color:\s*var\(--control-background,\s*transparent\);?\s*\}/,
      ),
      'utilities',
      'With any specificity the patch would win over the bg-input/30 of the command input and the has-disabled background',
    );
  });

  test('in dark mode --control-background falls back to the input/30 of nova, and a disabled or hovered control keeps its nova background', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.equal(
      layerOf(
        css,
        /\[data-slot=['"]?input['"]?\]\.dark\\:bg-input\\\/30:not\(:disabled\):is\(\.dark, \.dark \*\),\s*\[data-slot=['"]?textarea['"]?\]\.dark\\:bg-input\\\/30:not\(:disabled\):is\(\.dark, \.dark \*\),\s*\[data-slot=['"]?select-trigger['"]?\]\.dark\\:bg-input\\\/30:not\(:hover\):is\(\s*\.dark, \.dark \*\s*\),\s*\[data-slot=['"]?combobox-chips['"]?\]\.dark\\:bg-input\\\/30:is\(\.dark, \.dark \*\),\s*\[data-slot=['"]?input-group['"]?\]\.dark\\:bg-input\\\/30:not\(:has\(:disabled\)\):not\(\s*\[data-slot=['"]?command-input-wrapper['"]?\] > \*\s*\):is\(\.dark, \.dark \*\)\s*\{[^}]*color-mix\(in oklab, var\(--input\) 30%, transparent\)/,
      ),
      'utilities',
    );
  });

  test('a host sets the colour of a field label with --field-label-foreground, which inherits by default and leaves an invalid field its destructive colour', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.equal(
      layerOf(
        css,
        /:where\(\s*\[data-slot=['"]?field-label['"]?\]:not\(\s*\[data-slot=['"]?field['"]?\]\[data-invalid=['"]?true['"]?\] \*\s*\)\s*\)\s*\{\s*color:\s*var\(--field-label-foreground,\s*currentcolor\);?\s*\}/,
      ),
      'utilities',
      'nova gives a field label no colour class, so with any specificity the patch would win over a text-* class of the host',
    );
  });

  test('a host sets the size of a field label with --field-label-font-size, with the text-sm of nova as the fallback', async () => {
    // Act
    const css = await buildAppStylesheet();

    // Assert
    assert.equal(
      layerOf(
        css,
        /\[data-slot=['"]?field-label['"]?\]\.text-sm\s*\{\s*font-size:\s*var\(--field-label-font-size,\s*var\(--text-sm\)\);?\s*\}/,
      ),
      'utilities',
      'In an earlier layer the patch loses to the text-sm utility of the label',
    );
  });

  test('each control still has the nova class that its token patch is keyed on, so a sync that drops one fails here', async () => {
    // Arrange
    const { createElement: h } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const kit = await import('@zukhruf/shadcn');
    const classesOf = (markup: string, slot: string) => {
      const element = new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`).exec(
        markup,
      );
      assert.ok(element, `${slot} must render`);
      const classes = /class="([^"]*)"/.exec(element[0])?.[1] ?? '';
      return new Set(classes.replaceAll('&gt;', '>').split(' '));
    };
    const anchors = [
      [h(kit.Input), 'input', ['h-8', 'bg-transparent', 'dark:bg-input/30']],
      [
        h(kit.Textarea),
        'textarea',
        ['min-h-16', 'bg-transparent', 'dark:bg-input/30'],
      ],
      [
        h(kit.Select, null, h(kit.SelectTrigger, null, h(kit.SelectValue))),
        'select-trigger',
        ['data-[size=default]:h-8', 'bg-transparent', 'dark:bg-input/30'],
      ],
      [
        h(kit.InputGroup, null, h(kit.InputGroupInput)),
        'input-group',
        ['h-8', 'has-[>textarea]:h-auto', 'dark:bg-input/30'],
      ],
      [
        h(kit.Combobox, null, h(kit.ComboboxChips)),
        'combobox-chips',
        ['min-h-8', 'bg-transparent', 'dark:bg-input/30'],
      ],
      [h(kit.Button), 'button', ['group/button', 'h-8']],
      [h(kit.Button, { size: 'sm' }), 'button', ['group/button', 'h-7']],
      [h(kit.FieldLabel), 'field-label', ['text-sm']],
      [h(kit.FieldTitle), 'field-label', ['text-sm']],
    ] as const;

    for (const [element, slot, classes] of anchors) {
      // Act
      const rendered = classesOf(renderToStaticMarkup(element), slot);

      // Assert
      for (const name of classes) {
        assert.ok(rendered.has(name), `${slot} must have the class ${name}`);
      }
    }
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
