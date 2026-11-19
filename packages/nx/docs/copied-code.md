# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. A fix in one copy is made in the other copy too, and the commit names both files.

## The workspace root gets no targets

**`src/test/plugin.ts` (`root !== '.'`) → `src/format/plugin.ts` (`dirname(file) !== '.'`).**
The workspace root is an Nx project when its `package.json` has an `nx` key or it has a `project.json`, but a plugin area gives it no targets (ADR 0003). The test area leaves out the test files that the root owns. The format area leaves out the root's own config file, so the root gets no `prettier --check .`. A third area that gives targets extracts the rule (backlog #4019).
