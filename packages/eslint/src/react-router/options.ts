import type { TypeOrValueSpecifier } from '../base/options.ts';

export interface ReactRouterOnlyThrowErrorOptions {
  /** More types that a react-router file may throw. */
  allow?: TypeOrValueSpecifier[];
}

// A loader or an action throws `redirect()`, `replace()` (a Response) or
// `data()` (a DataWithResponseInit) to stop and answer at once. React Router
// catches the thrown value and renders it, so it is not an error that loses
// its stack.
const ROUTER_THROWS: TypeOrValueSpecifier[] = [
  { from: 'lib', name: 'Response' },
  { from: 'package', package: 'react-router', name: 'DataWithResponseInit' },
];

/** Options for `@typescript-eslint/only-throw-error` in react-router files, with React Router's thrown types already allowed. */
export function reactRouterOnlyThrowError({
  allow = [],
}: ReactRouterOnlyThrowErrorOptions = {}) {
  return { allow: [...ROUTER_THROWS, ...allow] };
}
