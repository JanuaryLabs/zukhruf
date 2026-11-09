# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each file.

## In two places

**The members of a clock.**

- Places: `UiClock` in `src/clock.tsx`, and `WallClock` in `packages/async/src/clock.ts`.
- Same: `setTimeout`, `clearTimeout`, `performance.now()` and `Date.now()`.
- Differs: `UiClock` also has `setInterval` and `clearInterval`.
- Why it stays: [ADR 0001](./adr/0001-a-component-gets-the-clock-from-a-required-provider.md). A UI extension can not import `@zukhruf/async`, and each type is structural.
- Backlog: #4102. A third place is the time to decide.
