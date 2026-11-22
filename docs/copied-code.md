# Code copied in the repository's workflows

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each place.

## In two places

**The `expect` helper of a workflow test job (shell).**

- Places: the `affected-range` job and the `nx-release-version` job of `.github/workflows/actions.yml`.
- Same: `expect <name> <got> <want>` fails the step with a message when `<got>` is not `<want>`.
- Differs: the `nx-release-version` copy quotes the two values in its message, because they can be empty.
