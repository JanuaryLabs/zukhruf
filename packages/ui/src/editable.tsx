import { cn } from 'cn';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  createContext,
  use,
  useCallback,
  useRef,
  useState,
} from 'react';

type Label = { 'aria-label': string } | { 'aria-labelledby': string };

/** The owner opens and closes the edit (a React Router fetcher, a state machine). */
interface OwnerSave {
  editing: boolean;
  /** true when the Preview is clicked; false on cancel. Never false on commit: the owner closes. */
  onEditingChange: (editing: boolean) => void;
  /** A save is in flight: the input is disabled and a commit is ignored. */
  saving: boolean;
  /** Called with a trimmed, changed, non-empty value. The owner closes by editing={false}. */
  onValueCommit: (next: string) => void;
  defaultEditing?: never;
}

/** The package awaits the save, derives saving from it, and closes when it resolves. */
type PromiseSave = {
  saving?: never;
  /** Called with a trimmed, changed, non-empty value. A rejection keeps the edit open. */
  onValueCommit: (next: string) => PromiseLike<unknown>;
} & (
  | {
      editing: boolean;
      /** true when the Preview is clicked; false when the save resolves and on cancel. */
      onEditingChange: (editing: boolean) => void;
      defaultEditing?: never;
    }
  | {
      editing?: never;
      defaultEditing?: boolean;
      onEditingChange?: (editing: boolean) => void;
    }
);

type EditableProps = (OwnerSave | PromiseSave) & {
  /** The saved value. Each edit starts from it. */
  value: string;
  /** Gets focus when the edit ends, unless the user moved focus. Default: the Preview. */
  finalFocus?: RefObject<HTMLElement | null>;
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
  children: ReactNode;
};

interface EditableContextValue {
  state: { editing: boolean; saving: boolean; draft: string };
  actions: {
    open(): void;
    setDraft(next: string): void;
    commit(): void;
    cancel(): void;
  };
  meta: {
    value: string;
    finalFocus: RefObject<HTMLElement | null>;
    previewRef: RefObject<HTMLButtonElement | null>;
    disabled: boolean;
    placeholder: string | undefined;
    maxLength: number | undefined;
  };
}

const EditableContext = createContext<EditableContextValue | null>(null);

function useEditableContext(part: string): EditableContextValue {
  const context = use(EditableContext);
  if (context === null) {
    throw new Error(`<Editable.${part}> must be rendered inside <Editable>`);
  }
  return context;
}

/**
 * Edits a saved text value in place. It renders no element of its own: the
 * Preview shows while not editing and the Input while editing.
 */
export function Editable(props: EditableProps): ReactNode {
  const {
    value,
    finalFocus,
    disabled = false,
    placeholder,
    maxLength,
    children,
  } = props;
  const ownerMode = props.saving !== undefined;
  const controlled = props.editing !== undefined;

  const [ownEditing, setOwnEditing] = useState(props.defaultEditing ?? false);
  const [ownSaving, setOwnSaving] = useState(false);
  // A promise save in flight. The state above updates on the next render;
  // this guards a blur that arrives before it.
  const inFlight = useRef(false);
  const previewRef = useRef<HTMLButtonElement | null>(null);

  const editing = props.editing ?? ownEditing;
  const saving = props.saving ?? ownSaving;

  // null until the user types: each edit starts from the saved value.
  const [typed, setTyped] = useState<string | null>(null);
  if (!editing && typed !== null) setTyped(null);
  const draft = editing ? (typed ?? value) : value;

  const changeEditing = (next: boolean) => {
    if (!controlled) setOwnEditing(next);
    props.onEditingChange?.(next);
  };

  const cancel = () => changeEditing(false);

  const commit = () => {
    if (saving || inFlight.current) return;
    const trimmed = draft.trim();
    if (trimmed === '' || trimmed === value) {
      cancel();
      return;
    }
    if (ownerMode) {
      props.onValueCommit(trimmed);
      return;
    }
    inFlight.current = true;
    setOwnSaving(true);
    Promise.resolve(props.onValueCommit(trimmed)).then(
      () => {
        inFlight.current = false;
        setOwnSaving(false);
        changeEditing(false);
      },
      // The error is the owner's: the edit stays open with the draft.
      () => {
        inFlight.current = false;
        setOwnSaving(false);
      },
    );
  };

  const open = () => {
    if (!disabled) changeEditing(true);
  };

  return (
    <EditableContext
      value={{
        state: { editing, saving, draft },
        actions: { open, setDraft: setTyped, commit, cancel },
        meta: {
          value,
          finalFocus: finalFocus ?? previewRef,
          previewRef,
          disabled,
          placeholder,
          maxLength,
        },
      }}
    >
      {children}
    </EditableContext>
  );
}

/** A button that shows the value. A click opens the edit. Rendered only while not editing. */
function EditablePreview({
  className,
  children,
  ...label
}: Label & { className?: string; children?: ReactNode }): ReactNode {
  const { state, actions, meta } = useEditableContext('Preview');
  if (state.editing) return null;
  return (
    <button
      ref={meta.previewRef}
      type="button"
      {...label}
      dir="auto"
      onClick={actions.open}
      disabled={meta.disabled}
      className={cn(
        'cursor-pointer text-start hover:border-b hover:border-dashed hover:border-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        meta.value === '' && 'text-muted-foreground/50 italic',
        className,
      )}
    >
      {children ?? (meta.value === '' ? meta.placeholder : meta.value)}
    </button>
  );
}

// A bare input, not the Input of @zukhruf/shadcn: its fixed height, border,
// full width and md:text-sm fight the inline-text goal, and a consumer's text
// size cannot override md:text-sm. This one takes the text style around it,
// hugs its content and shows a faint wash 1 unit past the glyphs.
const fieldReset =
  '-mx-1 max-w-full rounded-sm bg-muted px-1 text-inherit outline-none field-sizing-content placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-60';

function hasNoFocus(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

/** A bare input that edits the draft. Rendered only while editing. */
function EditableInput({
  className,
  ...aria
}: Label & {
  className?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}): ReactNode {
  const { state, actions, meta } = useEditableContext('Input');
  const { saving } = state;
  const { finalFocus } = meta;
  // Blur commits only one frame after the input gets focus: the menu that
  // opened the edit may still move focus while it closes.
  const armed = useRef(false);

  // Runs when the input appears and again each time saving changes. When it
  // is not saving, the input takes focus with its text selected, also after
  // a refused save. When the input leaves the DOM the edit has ended, and
  // focus goes to finalFocus unless the user moved it.
  const attach = useCallback(
    (element: HTMLInputElement) => {
      let frame = 0;
      if (!saving) {
        element.focus({ preventScroll: true });
        element.select();
        frame = requestAnimationFrame(() => {
          element.focus({ preventScroll: true });
          element.select();
          armed.current = true;
        });
      }
      return () => {
        cancelAnimationFrame(frame);
        armed.current = false;
        requestAnimationFrame(() => {
          if (!element.isConnected && hasNoFocus()) {
            finalFocus.current?.focus();
          }
        });
      };
    },
    [saving, finalFocus],
  );

  if (!state.editing) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      // Escape ends the edit only, not a sheet or a dialog the input is in.
      event.stopPropagation();
      actions.cancel();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      actions.commit();
    }
  };

  return (
    <input
      ref={attach}
      {...aria}
      dir="auto"
      value={state.draft}
      onChange={(event) => actions.setDraft(event.target.value)}
      onBlur={() => {
        if (armed.current) actions.commit();
      }}
      onKeyDown={handleKeyDown}
      disabled={saving || meta.disabled}
      placeholder={meta.placeholder}
      maxLength={meta.maxLength}
      className={cn(fieldReset, className)}
    />
  );
}

Editable.Preview = EditablePreview;
Editable.Input = EditableInput;
