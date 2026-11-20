# Code copied from require-select-group

Two rules of the react concept check the same trap in two components of `@zukhruf/shadcn`. Each component's list has no padding of its own, and its group part carries it, so an item placed straight in the list sits off its line. `zukhruf/require-select-group` checks Select. `zukhruf/require-command-group` checks Command, and it copies the first rule's code instead of sharing it.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. The boundary of a shared helper then comes from three working copies, not from a guess. When a third rule needs the same bindings and walk, the shared parts move to `src/authoring` (backlog #5041). Until then, a fix in one copy is made in the other copy too, and the commit names both files. This note is the input for that step.

Paths are in `src/react`.

## Copied without a change

Apart from the part names, these parts of `require-select-group.ts` are the same in `require-command-group.ts`:

| Part            | What it does                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `kitBindings`   | Reads the local names a file binds to the kit's parts: named imports, aliases and namespace imports from `@zukhruf/shadcn`.            |
| `isMapCallback` | Tells a `.map(…)` or `.flatMap(…)` callback from any other function.                                                                   |
| `passesThrough` | The nodes an item passes through on its way into the JSX that holds it.                                                                |
| the upward walk | From each item to the nearest group part (fine) or list part (report). An item that a file hands to another component is not followed. |

## Copied with changes

**The part names.** `SelectItem`, `SelectGroup` and `SelectContent` become `CommandItem`, `CommandGroup` and `CommandList`.

**The doc comment and the message.** Why: the facts differ. `SelectContent` puts its children into Base UI's `Select.List`, which has no padding, and `alignItemWithTrigger` then shifts the popup off its trigger. `CommandList` has only `scroll-py-1`, so an item sits out of line with `CommandInput` and the grouped items, and nothing shifts.

**The tests.** `require-command-group.test.ts` has the cases of `require-select-group.test.ts` for Command, plus `CommandEmpty` and `CommandSeparator` straight in the list (shadcn's own examples put them there), and the same parts imported from `cmdk`, which the rule does not check.
