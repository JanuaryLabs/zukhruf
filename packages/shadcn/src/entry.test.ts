import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import * as shadcn from '@zukhruf/shadcn';

describe('the entry of @zukhruf/shadcn', () => {
  for (const subpath of [
    'components/button',
    'lib/utils',
    'hooks/use-mobile',
    'theme.css',
    'dist/index.js',
  ]) {
    test(`refuses the subpath ${subpath}, so an app imports only from the entry`, () => {
      // Act
      const resolve = () => import.meta.resolve(`@zukhruf/shadcn/${subpath}`);

      // Assert
      assert.throws(resolve, { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    });
  }

  test('resolves the entry and the stylesheet', () => {
    // Act
    const entry = import.meta.resolve('@zukhruf/shadcn');
    const stylesheet = import.meta.resolve('@zukhruf/shadcn/styles.css');

    // Assert
    assert.match(entry, /\/dist\/index\.js$/);
    assert.match(stylesheet, /\/styles\.css$/);
  });

  test('exports each export of each shipped component, hook and hand-written module', async () => {
    // Arrange: the shipped modules sit beside the entry in dist.
    const distDirectory = dirname(
      fileURLToPath(import.meta.resolve('@zukhruf/shadcn')),
    );
    const modules = [];
    for (const folder of ['components', 'hooks', 'hand-written']) {
      for (const file of await readdir(join(distDirectory, folder))) {
        if (file.endsWith('.js'))
          modules.push(join(distDirectory, folder, file));
      }
    }

    // Act
    const entry = new Map(Object.entries(shadcn));
    const missing = [];
    for (const path of modules) {
      const module: Record<string, unknown> = await import(
        pathToFileURL(path).href
      );
      for (const [name, value] of Object.entries(module)) {
        if (entry.get(name) !== value) {
          missing.push(`${name} from ${path.slice(distDirectory.length)}`);
        }
      }
    }

    // Assert
    assert.ok(
      modules.length > 60,
      `Expected the shipped components, got ${modules.length}`,
    );
    assert.deepEqual(missing, []);
  });

  test('renders Checkbox with the data-checked and data-unchecked attributes of Base UI, not the data-state of Radix', () => {
    // Act
    const unchecked = renderToStaticMarkup(createElement(shadcn.Checkbox));
    const checked = renderToStaticMarkup(
      createElement(shadcn.Checkbox, { defaultChecked: true }),
    );

    // Assert
    assert.match(unchecked, /^<[a-z]+ [^>]*data-unchecked=""/);
    assert.match(checked, /^<[a-z]+ [^>]*data-checked=""/);
    assert.doesNotMatch(unchecked + checked, /data-state=/);
  });

  test('renders Button as a button with the class that the stylesheet colors', () => {
    // Act
    const markup = renderToStaticMarkup(
      createElement(shadcn.Button, { variant: 'default' }, 'Save'),
    );

    // Assert
    assert.match(markup, /^<button [^>]*data-slot="button"/);
    const classes = /class="([^"]*)"/.exec(markup)?.[1]?.split(' ');
    assert.ok(
      classes?.includes('bg-primary'),
      `The resting background class must be on the button: ${classes?.join(' ')}`,
    );
    assert.match(markup, />Save<\/button>$/);
  });
});
