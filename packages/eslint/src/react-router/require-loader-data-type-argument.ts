import { selectorRule } from '../authoring/selector-rule.ts';

/**
 * react-router's `useLoaderData<T = any>()` defaults its type argument to
 * `any`, so annotating the receiving variable (`const x: T = useLoaderData()`)
 * compiles whatever the loader returns. Only the type-argument form,
 * `useLoaderData<typeof loader>()`, connects the component to its loader.
 * `useRouteLoaderData` has the same trap.
 */
export default selectorRule({
  description:
    'Require a type argument on useLoaderData() and useRouteLoaderData()',
  selectors: [
    'CallExpression[callee.name=/^use(Route)?LoaderData$/]:not([typeArguments])',
  ],
  message:
    'Bare useLoaderData()/useRouteLoaderData() returns `any` — pass the generic (e.g. useLoaderData<typeof loader>()) so the return type is compiler-checked.',
});
