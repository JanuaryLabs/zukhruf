import { selectorRule } from '../authoring/selector-rule.ts';

export default selectorRule({
  description:
    'Disallow the Radix `asChild` prop; Base UI sets the rendered element with `render`',
  selectors: ["JSXAttribute[name.name='asChild']"],
  message:
    'Do not use `asChild`. It is a Radix UI prop, and Base UI does not have it. Use the `render` prop: `<DialogTrigger render={<Button />}>`. When the element is not a button, also set `nativeButton={false}`. For a link that looks like a button, do not use `render`. Use a plain link with `className={cn(buttonVariants(...))}`.',
});
