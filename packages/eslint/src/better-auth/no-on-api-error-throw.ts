import { selectorRule } from '../authoring/selector-rule.ts';

/**
 * In better-auth 1.7, `onAPIError.throw` rethrows before `onAPIError.onError`
 * and before better-auth logs the error. better-call's router catches the
 * rethrow and turns it into a response, so the app's own error handler never
 * runs, and no 4xx is logged anywhere.
 */
export default selectorRule({
  description: "Disallow better-auth's onAPIError.throw",
  selectors: [
    "Property:matches([key.name='onAPIError'], [key.value='onAPIError']) > ObjectExpression > Property:matches([key.name='throw'], [key.value='throw'])[value.value=true]",
  ],
  message:
    "onAPIError.throw rethrows before better-auth logs the error, and better-call turns the rethrow into a response, so the app's error handler never sees it. Log in onAPIError.onError instead.",
});
