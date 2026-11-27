import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { ComponentProps } from 'react';

import type { Editable as EditableType } from '@zukhruf/ui';

// React DOM checks for a DOM when it loads, so each test loads it after it
// registers the DOM.

/** Waits for the next animation frame, after each frame asked for before it. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Types text into a React input: the value setter of the prototype, then an input event. */
function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(
  target: Element,
  key: string,
  init: KeyboardEventInit = {},
): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

function input(): HTMLInputElement {
  const element = document.querySelector('input');
  assert.ok(element, 'the input is rendered');
  return element;
}

test('opening the edit focuses the input with its whole text selected', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Editable } = await import('@zukhruf/ui');
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    try {
      await act(async () => {
        root.render(
          createElement(Editable, {
            value: 'Quarterly report',
            onValueCommit: async () => undefined,
            children: [
              createElement(Editable.Preview, {
                key: 'preview',
                'aria-label': 'Rename',
              }),
              createElement(Editable.Input, {
                key: 'input',
                'aria-label': 'Title',
              }),
            ],
          }),
        );
      });

      // Act
      await act(async () => {
        document.querySelector('button')?.click();
      });
      await act(nextFrame);

      // Assert
      const field = input();
      assert.equal(document.activeElement, field);
      assert.deepEqual(
        { start: field.selectionStart, end: field.selectionEnd },
        { start: 0, end: 'Quarterly report'.length },
      );
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('Enter commits the trimmed value once, and a blank or unchanged value ends the edit with no commit', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Editable } = await import('@zukhruf/ui');
    const commits: string[] = [];
    const roots: ReturnType<typeof createRoot>[] = [];
    const editAndPressEnter = async (text: string) => {
      const root = createRoot(
        document.body.appendChild(document.createElement('div')),
      );
      roots.push(root);
      await act(async () => {
        root.render(
          createElement(Editable, {
            value: 'Draft',
            defaultEditing: true,
            onValueCommit: async (next: string) => {
              commits.push(next);
            },
            children: createElement(Editable.Input, { 'aria-label': 'Title' }),
          }),
        );
      });
      await act(async () => typeInto(input(), text));
      await act(async () => press(input(), 'Enter'));
      const open = document.querySelector('input') !== null;
      await act(async () => root.unmount());
      return open;
    };
    try {
      // Act
      const afterChanged = await editAndPressEnter('  Final  ');
      const afterBlank = await editAndPressEnter('   ');
      const afterUnchanged = await editAndPressEnter(' Draft ');

      // Assert
      assert.deepEqual(commits, ['Final']);
      assert.deepEqual(
        { afterChanged, afterBlank, afterUnchanged },
        { afterChanged: false, afterBlank: false, afterUnchanged: false },
      );
    } finally {
      for (const root of roots) await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('Escape ends the edit with no commit, and a keydown listener on the document never sees it', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Editable } = await import('@zukhruf/ui');
    const commits: string[] = [];
    const seenByDocument: string[] = [];
    const listener = (event: KeyboardEvent) => seenByDocument.push(event.key);
    document.addEventListener('keydown', listener);
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    try {
      await act(async () => {
        root.render(
          createElement(Editable, {
            value: 'Draft',
            defaultEditing: true,
            onValueCommit: async (next: string) => {
              commits.push(next);
            },
            children: createElement(Editable.Input, { 'aria-label': 'Title' }),
          }),
        );
      });
      await act(async () => typeInto(input(), 'Changed'));

      // Act
      await act(async () => press(input(), 'Escape'));

      // Assert
      assert.equal(document.querySelector('input'), null);
      assert.deepEqual(commits, []);
      assert.deepEqual(seenByDocument, []);
    } finally {
      document.removeEventListener('keydown', listener);
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('a blur in the first frame after opening does not commit, and a blur after it commits', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Editable } = await import('@zukhruf/ui');
    const commits: string[] = [];
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    try {
      await act(async () => {
        root.render(
          createElement(Editable, {
            value: 'Draft',
            onValueCommit: async (next: string) => {
              commits.push(next);
            },
            children: [
              createElement(Editable.Preview, {
                key: 'preview',
                'aria-label': 'Rename',
              }),
              createElement(Editable.Input, {
                key: 'input',
                'aria-label': 'Title',
              }),
            ],
          }),
        );
      });

      // Act: a synchronous act runs no frame, so the blur lands in the
      // first frame after the click.
      act(() => document.querySelector('button')?.click());
      act(() => typeInto(input(), 'Changed'));
      act(() => input().blur());
      const afterEarlyBlur = [...commits];
      await act(nextFrame);
      await act(async () => input().blur());

      // Assert
      assert.deepEqual(afterEarlyBlur, []);
      assert.deepEqual(commits, ['Changed']);
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('Enter while an input method is composing does nothing', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Editable } = await import('@zukhruf/ui');
    const commits: string[] = [];
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    try {
      await act(async () => {
        root.render(
          createElement(Editable, {
            value: 'Draft',
            defaultEditing: true,
            onValueCommit: async (next: string) => {
              commits.push(next);
            },
            children: createElement(Editable.Input, { 'aria-label': 'Title' }),
          }),
        );
      });
      await act(async () => typeInto(input(), '漢字'));

      // Act
      await act(async () => press(input(), 'Enter', { isComposing: true }));
      await act(async () => press(input(), 'Escape', { isComposing: true }));

      // Assert
      assert.deepEqual(commits, []);
      assert.equal(input().value, '漢字');
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('promise mode closes the edit when the save resolves and stays open with the draft and focus when it rejects', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Editable } = await import('@zukhruf/ui');
    const saves: PromiseWithResolvers<void>[] = [];
    const editingChanges: boolean[] = [];
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    try {
      await act(async () => {
        root.render(
          createElement(Editable, {
            value: 'Draft',
            defaultEditing: true,
            onEditingChange: (editing: boolean) => editingChanges.push(editing),
            onValueCommit: () => {
              const save = Promise.withResolvers<void>();
              saves.push(save);
              return save.promise;
            },
            children: createElement(Editable.Input, { 'aria-label': 'Title' }),
          }),
        );
      });
      await act(nextFrame);

      // Act
      await act(async () => typeInto(input(), 'Refused'));
      await act(async () => press(input(), 'Enter'));
      const disabledWhileSaving = input().disabled;
      await act(async () => saves[0]?.reject(new Error('taken')));
      const afterReject = {
        open: document.querySelector('input') !== null,
        draft: input().value,
        focused: document.activeElement === input(),
        disabled: input().disabled,
      };
      await act(nextFrame);
      await act(async () => typeInto(input(), 'Accepted'));
      await act(async () => press(input(), 'Enter'));
      await act(async () => saves[1]?.resolve());

      // Assert
      assert.equal(disabledWhileSaving, true);
      assert.deepEqual(afterReject, {
        open: true,
        draft: 'Refused',
        focused: true,
        disabled: false,
      });
      assert.equal(document.querySelector('input'), null);
      assert.deepEqual(editingChanges, [false]);
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('owner mode does not close on commit, ignores a commit while saving, and focuses the input again when saving ends with the edit open', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Editable } = await import('@zukhruf/ui');
    const commits: string[] = [];
    const editingChanges: boolean[] = [];
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    const render = (saving: boolean) =>
      act(async () => {
        root.render(
          createElement(Editable, {
            value: 'Draft',
            editing: true,
            saving,
            onEditingChange: (editing: boolean) => editingChanges.push(editing),
            onValueCommit: (next: string) => {
              commits.push(next);
            },
            children: createElement(Editable.Input, { 'aria-label': 'Title' }),
          }),
        );
      });
    try {
      await render(false);
      await act(nextFrame);

      // Act
      await act(async () => typeInto(input(), 'Changed'));
      await act(async () => press(input(), 'Enter'));
      const openAfterCommit = document.querySelector('input') !== null;
      await render(true);
      const disabledWhileSaving = input().disabled;
      await act(async () => press(input(), 'Enter'));
      await act(async () => input().blur());
      await render(false);

      // Assert
      assert.equal(openAfterCommit, true);
      assert.equal(disabledWhileSaving, true);
      assert.deepEqual(commits, ['Changed']);
      assert.deepEqual(editingChanges, []);
      assert.equal(document.activeElement, input());
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('focus goes to finalFocus when Enter ends the edit, stays on a button the user blurred onto, and saving while open never moves it there', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement, createRef } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Editable } = await import('@zukhruf/ui');
    const row = document.body.appendChild(document.createElement('a'));
    row.href = '#row';
    const other = document.body.appendChild(document.createElement('button'));
    const finalFocus = createRef<HTMLElement>();
    finalFocus.current = row;
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    const render = (editing: boolean, saving: boolean) =>
      act(async () => {
        root.render(
          createElement(Editable, {
            value: 'Draft',
            editing,
            saving,
            finalFocus,
            onEditingChange: () => undefined,
            onValueCommit: () => undefined,
            children: editing
              ? createElement(Editable.Input, { 'aria-label': 'Title' })
              : null,
          }),
        );
      });
    try {
      // Act: Enter commits, the owner saves and then closes.
      await render(true, false);
      await act(nextFrame);
      await act(async () => typeInto(input(), 'Changed'));
      await act(async () => press(input(), 'Enter'));
      await render(true, true);
      await act(async () => input().blur());
      await act(nextFrame);
      const focusWhileSaving = document.activeElement;
      await render(true, false);
      await act(nextFrame);
      await render(false, false);
      await act(nextFrame);
      const focusAfterEnter = document.activeElement;

      // Act: a blur onto another button commits, and the owner closes.
      await render(true, false);
      await act(nextFrame);
      await act(async () => typeInto(input(), 'Again'));
      await act(async () => other.focus());
      await render(false, false);
      await act(nextFrame);
      const focusAfterBlur = document.activeElement;

      // Assert
      assert.notEqual(focusWhileSaving, row);
      assert.equal(focusAfterEnter, row);
      assert.equal(focusAfterBlur, other);
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('inside a dialog that takes focus when its focused child leaves, Escape, Enter that cancels and Enter that commits each put focus on finalFocus', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement, createRef } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Editable } = await import('@zukhruf/ui');
    // A modal's focus guard: when the focused element leaves the DOM, the
    // dialog focuses itself before the next frame, as Base UI's Dialog does.
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    dialog.tabIndex = -1;
    const guard = new MutationObserver(() => {
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected) {
        dialog.focus();
      }
    });
    guard.observe(dialog, { childList: true, subtree: true });
    const row = dialog.appendChild(document.createElement('a'));
    row.href = '#row';
    const finalFocus = createRef<HTMLElement>();
    finalFocus.current = row;
    const root = createRoot(dialog.appendChild(document.createElement('div')));
    const focusAfter = async (key: string, text?: string) => {
      await act(async () => {
        root.render(
          createElement(Editable, {
            key: `${key}-${text}`,
            value: 'Draft',
            defaultEditing: true,
            finalFocus,
            onValueCommit: async () => undefined,
            children: createElement(Editable.Input, { 'aria-label': 'Title' }),
          }),
        );
      });
      await act(nextFrame);
      if (text !== undefined) await act(async () => typeInto(input(), text));
      await act(async () => press(input(), key));
      await act(nextFrame);
      const focused = document.activeElement;
      return focused === row ? 'row' : (focused?.getAttribute('role') ?? null);
    };
    try {
      // Act
      const afterEscape = await focusAfter('Escape', 'Changed');
      const afterUnchangedEnter = await focusAfter('Enter');
      const afterCommitEnter = await focusAfter('Enter', 'Renamed');

      // Assert
      assert.deepEqual(
        { afterEscape, afterUnchangedEnter, afterCommitEnter },
        {
          afterEscape: 'row',
          afterUnchangedEnter: 'row',
          afterCommitEnter: 'row',
        },
      );
    } finally {
      guard.disconnect();
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('an uncontrolled Preview click opens the edit and reports it, and after a cancel the Preview has focus', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Editable } = await import('@zukhruf/ui');
    const editingChanges: boolean[] = [];
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    try {
      await act(async () => {
        root.render(
          createElement(Editable, {
            value: 'Draft',
            onEditingChange: (editing: boolean) => editingChanges.push(editing),
            onValueCommit: async () => undefined,
            children: [
              createElement(Editable.Preview, {
                key: 'preview',
                'aria-label': 'Rename',
              }),
              createElement(Editable.Input, {
                key: 'input',
                'aria-label': 'Title',
              }),
            ],
          }),
        );
      });

      // Act
      await act(async () => document.querySelector('button')?.click());
      const inputShown = document.querySelector('input') !== null;
      await act(nextFrame);
      await act(async () => press(input(), 'Escape'));
      await act(nextFrame);

      // Assert
      assert.equal(inputShown, true);
      assert.deepEqual(editingChanges, [true, false]);
      const preview = document.querySelector('button');
      assert.ok(preview);
      assert.equal(document.activeElement, preview);
      assert.equal(preview.textContent, 'Draft');
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('the Input and the Preview have dir="auto" and the accessible names they are given', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Editable } = await import('@zukhruf/ui');
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    const render = (editing: boolean) =>
      act(async () => {
        root.render(
          createElement(Editable, {
            value: 'عنوان',
            editing,
            onEditingChange: () => undefined,
            onValueCommit: async () => undefined,
            children: [
              createElement(Editable.Preview, {
                key: 'preview',
                'aria-label': 'Rename',
              }),
              createElement(Editable.Input, {
                key: 'input',
                'aria-labelledby': 'title-label',
              }),
            ],
          }),
        );
      });
    try {
      // Act
      await render(false);
      const preview = document.querySelector('button');
      const previewAttributes = {
        dir: preview?.getAttribute('dir'),
        label: preview?.getAttribute('aria-label'),
      };
      await render(true);
      const field = input();

      // Assert
      assert.deepEqual(previewAttributes, { dir: 'auto', label: 'Rename' });
      assert.deepEqual(
        {
          dir: field.getAttribute('dir'),
          labelledBy: field.getAttribute('aria-labelledby'),
        },
        { dir: 'auto', labelledBy: 'title-label' },
      );
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('a part outside an Editable throws with its own name', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Editable } = await import('@zukhruf/ui');
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    try {
      // Act and assert
      await assert.rejects(async () => {
        await act(async () => {
          root.render(createElement(Editable.Input, { 'aria-label': 'Title' }));
        });
      }, /<Editable\.Input> must be rendered inside <Editable>/);
      await assert.rejects(async () => {
        await act(async () => {
          root.render(
            createElement(Editable.Preview, { 'aria-label': 'Rename' }),
          );
        });
      }, /<Editable\.Preview> must be rendered inside <Editable>/);
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('the root renders no element of its own, so each part is a direct child of the container of the owner', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { Editable } = await import('@zukhruf/ui');
    const container = document.body.appendChild(document.createElement('li'));
    const root = createRoot(container);
    const render = (editing: boolean) =>
      act(async () => {
        root.render(
          createElement(Editable, {
            value: 'Draft',
            editing,
            onEditingChange: () => undefined,
            onValueCommit: async () => undefined,
            children: [
              createElement(Editable.Preview, {
                key: 'preview',
                'aria-label': 'Rename',
              }),
              createElement(Editable.Input, {
                key: 'input',
                'aria-label': 'Title',
              }),
            ],
          }),
        );
      });
    try {
      // Act
      await render(false);
      const whileNotEditing = [...container.children].map((c) => c.tagName);
      await render(true);
      const whileEditing = [...container.children].map((c) => c.tagName);

      // Assert
      assert.deepEqual(whileNotEditing, ['BUTTON']);
      assert.deepEqual(whileEditing, ['INPUT']);
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});

test('the types refuse an unlabelled Input, a mixed owner mode, mixed controlled and uncontrolled editing, and a save that returns nothing', () => {
  type RootProps = ComponentProps<typeof EditableType>;
  type InputProps = ComponentProps<typeof EditableType.Input>;
  const commit = async () => undefined;
  const change = () => undefined;

  const accepted: unknown[] = [
    { 'aria-label': 'Title' } satisfies InputProps,
    {
      value: '',
      editing: true,
      saving: false,
      onEditingChange: change,
      onValueCommit: change,
      children: null,
    } satisfies RootProps,
    {
      value: '',
      editing: true,
      onEditingChange: change,
      onValueCommit: commit,
      children: null,
    } satisfies RootProps,
    {
      value: '',
      defaultEditing: true,
      onValueCommit: commit,
      children: null,
    } satisfies RootProps,
  ];

  const unlabelled = {};
  const savingWithoutEditing = {
    value: '',
    saving: false,
    onEditingChange: change,
    onValueCommit: change,
    children: null,
  };
  const ownerWithDefaultEditing = {
    value: '',
    editing: true,
    defaultEditing: true,
    saving: false,
    onEditingChange: change,
    onValueCommit: change,
    children: null,
  };
  const controlledAndUncontrolled = {
    value: '',
    editing: true,
    defaultEditing: true,
    onEditingChange: change,
    onValueCommit: commit,
    children: null,
  };
  const controlledWithoutChange = {
    value: '',
    editing: true,
    onValueCommit: commit,
    children: null,
  };
  const saveReturnsNothing = {
    value: '',
    defaultEditing: true,
    onValueCommit: change,
    children: null,
  };
  const refused: unknown[] = [
    // @ts-expect-error the Input needs aria-label or aria-labelledby
    unlabelled satisfies InputProps,
    // @ts-expect-error owner mode needs editing beside saving
    savingWithoutEditing satisfies RootProps,
    // @ts-expect-error owner mode takes no defaultEditing
    ownerWithDefaultEditing satisfies RootProps,
    // @ts-expect-error promise mode is controlled or uncontrolled, not both
    controlledAndUncontrolled satisfies RootProps,
    // @ts-expect-error a controlled promise mode needs onEditingChange to close
    controlledWithoutChange satisfies RootProps,
    // @ts-expect-error promise mode needs a save that returns a promise
    saveReturnsNothing satisfies RootProps,
  ];

  assert.equal(accepted.length, 4);
  assert.equal(refused.length, 6);
});
