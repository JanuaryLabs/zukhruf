# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each file.

## In two places

**The members of a clock.**

- Places: `UiClock` in `src/clock.tsx`, and `WallClock` in `packages/async/src/clock.ts`.
- Same: `setTimeout`, `clearTimeout`, `performance.now()` and `Date.now()`.
- Differs: `UiClock` also has `setInterval` and `clearInterval`.
- Why it stays: [ADR 0001](./adr/0001-a-component-gets-the-clock-from-a-required-provider.md). A UI extension can not import `@zukhruf/async`, and each type is structural.
- Backlog: #4102. A third place is the time to decide.

## In other repositories

**Inline editing of a text value: draft, trim, commit a changed value, cancel otherwise.**

- Places: `Editable` in `src/editable.tsx`; deepagents `packages/devtool/host/ui/src/routes/scheduled.tsx` (`CommittingInput`, `CommittingTextarea`) and `apps/evals-web-runner/frontend/src/app/routes/suites/SuiteDetail.tsx` (the inline form with Save and Cancel).
- Same: a trimmed, changed value commits; SuiteDetail also cancels on Escape and focuses the field on mount.
- Differs: `scheduled.tsx` always shows a field and has no Escape and no focus return; SuiteDetail has Save and Cancel buttons.
- Why they stay: moving them is a change a user sees (the fields become text until clicked, the buttons go), and that change has no go. Backlog: #6124.
- Rule while they stay: a fix in `Editable` that also applies to them (trim, the unchanged cancel, Escape) is named in its commit, so a later move has the list.
