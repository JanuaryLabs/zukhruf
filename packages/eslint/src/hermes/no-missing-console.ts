import { selectorRule } from '../authoring/selector-rule.ts';

// React Native's console polyfill (@react-native/js-polyfills) forwards these
// to the host console only under __DEV__, and never defines timeLog. A release
// build has none of them.
const MISSING = '/^(clear|dir|dirxml|profile|profileEnd|timeLog)$/';

export default selectorRule({
  description:
    'Disallow console methods that React Native release builds do not have',
  selectors: [
    `MemberExpression[object.name='console'][computed=false][property.name=${MISSING}]`,
    `MemberExpression[object.name='console'][computed=true][property.value=${MISSING}]`,
    // A computed name can be any of the missing methods.
    `MemberExpression[object.name='console'][computed=true]:not([property.type='Literal'])`,
  ],
  message:
    'React Native release builds have no console.clear, dir, dirxml, profile, profileEnd or timeLog: the call throws "undefined is not a function". A computed console[name] can name one of them. Use console.log, info, warn, error, debug, trace, table, group or assert.',
});
