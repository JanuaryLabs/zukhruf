# A component gets the clock from a required provider

[Root ADR 0004](../../../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md) says that a library that waits on a timer or reads the time takes the clock as an input. That ADR gives the clock to a function or a constructor. A React component has a different shape: a parent renders it, and the parent often does not know that it waits. `TheButton` waits for its delay, and its test sleeps for 1.3 seconds of real time.

The rule `island/no-ambient-time` is off for this package, and for the same reason in context-compiler and text2sql. Those repositories wait on this decision.

## Decision

A component gets the clock from a React context. `@zukhruf/ui` exports `ClockProvider` and `useClock`. `useClock` throws when no provider is above the component. There is no default clock, by the same rule as root ADR 0004. The maintainer chose this option, "Required context", on 2026-11-09.

Each app root gives `globalThis`. A test gives a provider with `createClock()` of `@sinonjs/fake-timers`.

`TheButton` calls `useClock` on each render, not only while it loads. A missing provider then fails at the first render, and a test or an app can not miss it until a load starts.

The type is `UiClock`, and this package declares it. It has `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `Date.now()` and `performance.now()`. Root ADR 0004 says that the type has only the members that the library calls. One tree has one provider, so the type has the members that the components of the tree call. Each member has a real caller in the 30 sites of the three repositories. The type does not come from `@zukhruf/async`, for three reasons:

- [Root ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md) lets a UI extension import only the UI layer. `@zukhruf/async` is in the base layer.
- `Clock` and `WallClock` of `@zukhruf/async` do not have `setInterval`, because no wait there calls it.
- The type is structural, so an import gives no safety. A `UiClock` is a valid `Clock` and a valid `WallClock` with no import, and `globalThis` and `createClock()` are valid `UiClock` values. A compile of each of these assignments passed.

A decision about "now" stays a function that takes the time as an argument, as root ADR 0004 says. Only the component that calls the function reads the clock.

Generated code stays out. `packages/shadcn/src` is written by the CLI of shadcn ([shadcn ADR 0001](../../../shadcn/docs/adr/0001-the-shadcn-cli-writes-the-source-and-the-commit-pins-it.md)), and a UI package can not import a UI extension. Thus `code-block.tsx` keeps its timer, and the rule stays off for that folder.

## Considered Options

- **A required `clock` prop.** It obeys root ADR 0004 with no new concept. But each parent must pass the clock through, also a parent that does not wait. text2sql has 169 `<TheButton` elements in 77 files, and factory has 12. A site deep in a hook, for example `useCopyFeedback`, moves the prop to each of its callers.
- **A context with `globalThis` as its default.** No app changes. But a test that forgets the provider runs on real time and passes, slowly. This is the default that root ADR 0004 forbids.
- **Leave React out of the rule.** No code changes. The real sleeps stay, and tests can not reach the gaps that root ADR 0004 lists. Three repositories keep a scope block with no end.
- **A required context.** This option was selected. TanStack Query has the same shape: `client` is a required prop of `QueryClientProvider`, and `useQueryClient` throws `No QueryClient set, use QueryClientProvider to set one` (`src/QueryClientProvider.tsx` in `@tanstack/react-query` 5.99.0).

## Consequences

- A missing provider is an error at run time. The compiler and the lint can not see it. Thus a consumer adds the provider in the same change that moves to the new version of `@zukhruf/ui`, and runs the tests that render a component.
- Each test that renders a `TheButton` needs a provider, also when the test does not care about time. A package whose third test needs it moves a helper to its `src/testing`, by the Rule of Three.
- Each repository whose tests give the clock adds `@sinonjs/fake-timers` as a dev dependency. text2sql, factory, deepagents and context-compiler do not have it.
- A package that exports a whole screen to a third party has no app root of its own. `@limerence-ai/react` of text2sql is public, and its `LimerenceChat` reaches the sites. Its top component gives the provider, or its README tells the app to give it.
- No consumer has React Server Components, so `globalThis` never crosses that boundary, and this package needs no `use client`. On a server render an effect does not run and `globalThis` is valid. text2sql's `apps/website` sets `ssr: false`.
- `@zukhruf/ui` depends on `react-dom` and `@zukhruf/shadcn`, so React Native can not import it. The mobile app of whatisgoingon does not import `@zukhruf/ui`, and its lint config does not use `island/recommended`. This decision does not reach it.
- `@zukhruf/diagram` is in the UI layer and can not import this package. It has no site of the rule today.
- `UiClock` and `WallClock` of `@zukhruf/async` are two places. `packages/ui/docs/copied-code.md` records this at the implementation, with a backlog item for a third place.
