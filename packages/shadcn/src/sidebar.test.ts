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

/** The innermost `@layer` that encloses `index` (see styles.test.ts). */
function layerAt(css: string, index: number) {
  const enclosing: string[] = [];
  let prelude = '';
  for (const character of css.slice(0, index)) {
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

/**
 * The specificity of one compound selector, as [ids, classes, types]. A
 * selector with a combinator or a functional pseudo-class fails the test,
 * because this count does not handle it.
 */
function specificityOf(selector: string) {
  const unescaped = selector.trim().replaceAll(/\\./g, 'x');
  assert.doesNotMatch(unescaped, /[\s>+~(]/, `${selector} must be compound`);
  const withoutAttributes = unescaped.replaceAll(/\[[^\]]*\]/g, '');
  const attributes = (unescaped.match(/\[[^\]]*\]/g) ?? []).length;
  const ids = (withoutAttributes.match(/#[\w-]+/g) ?? []).length;
  const classes = (withoutAttributes.match(/\.[\w-]+/g) ?? []).length;
  const pseudoClasses = (withoutAttributes.match(/(?<!:):[\w-]+/g) ?? [])
    .length;
  const types = /^[a-z]/i.test(withoutAttributes) ? 1 : 0;
  return [ids, classes + attributes + pseudoClasses, types];
}

/** True when specificity `a` is higher than specificity `b`. */
function isHigher(a: number[], b: number[]) {
  const difference = a.findIndex((value, index) => value !== b[index]);
  return difference !== -1 && (a[difference] ?? 0) > (b[difference] ?? 0);
}

const layerOrder = ['theme', 'base', 'components', 'utilities'];

test('the open mobile sidebar takes --sidebar-width, and the 3/4 width of the Sheet loses to it', async () => {
  // Arrange: a window of 390px is below the mobile breakpoint of the
  // sidebar. React DOM and Base UI check for a DOM when they load, so they
  // load after the DOM exists.
  const css = await buildAppStylesheet();
  const sheetWidth =
    /([^{};]+)\{\s*width:\s*calc\(3 \/ 4 \* 100%\);?\s*\}/.exec(css);
  assert.ok(sheetWidth?.[1], 'The Sheet must give a side sheet 3/4 width');
  const sidebarWidths = [
    ...css.matchAll(/([^{};]+)\{\s*width:\s*var\(--sidebar-width\);?\s*\}/g),
  ];
  GlobalRegistrator.register({ width: 390, height: 844 });
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Sidebar, SidebarProvider, SidebarTrigger } =
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

      // Assert: a rule that sets --sidebar-width selects the mobile sidebar,
      // and it wins over the 3/4 width, which also selects it. A later layer
      // wins; in the same layer, a higher specificity wins.
      const sidebar = document.querySelector('[data-mobile="true"]');
      assert.ok(sidebar, 'The trigger must open the mobile sidebar');
      assert.ok(
        sidebar.matches(sheetWidth[1].trim()),
        'The 3/4 width of the Sheet must select the mobile sidebar',
      );
      const sheetLayer = layerOrder.indexOf(
        layerAt(css, sheetWidth.index) ?? '',
      );
      const sheetSpecificity = specificityOf(sheetWidth[1]);
      const winner = sidebarWidths.find((rule) => {
        const selector = rule[1]?.trim() ?? '';
        if (!sidebar.matches(selector)) {
          return false;
        }
        const layer = layerOrder.indexOf(layerAt(css, rule.index) ?? '');
        if (layer !== sheetLayer) {
          return layer > sheetLayer;
        }
        return isHigher(specificityOf(selector), sheetSpecificity);
      });
      assert.ok(
        winner,
        `A rule with width: var(--sidebar-width) must select the mobile sidebar and win over ${sheetWidth[1].trim()}`,
      );
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});
