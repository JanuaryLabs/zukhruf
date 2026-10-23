# @zukhruf/git-hooks

Git hooks written in TypeScript. A pre-commit hook runs steps in order against the staged commit. The steps check the staged copy of each file with Prettier and change nothing, run `nx sync` and stage only the files that sync wrote, and build generated files when nx says that their projects are affected. A repo adds a step of its own as a class.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Install the hook

Add the package and the repo's own Prettier:

```sh
npm install --save-dev @zukhruf/git-hooks prettier
```

Write the hook in `.husky/pre-commit.ts`, and make it executable:

```ts
#!/usr/bin/env node
import { Format, preCommit } from '@zukhruf/git-hooks';

await preCommit([new Format()]);
```

Git runs a hook by its name, and Node runs a TypeScript file only when its name ends in `.ts`. So `.husky/pre-commit` is a link to the TypeScript file. Commit the link:

```sh
chmod +x .husky/pre-commit.ts
ln -s pre-commit.ts .husky/pre-commit
```

Tell git where the hooks are, in the `prepare` script of `package.json`:

```json
{ "scripts": { "prepare": "git config core.hooksPath .husky || exit 0" } }
```

## Check the format of the staged files

`Format` checks the staged copy of each staged file with the Prettier config of the repo. It skips the files that `.prettierignore` names and the files that Prettier has no parser for. When a file is not formatted, or Prettier cannot parse it, the commit stops and the hook names each file:

```text
format    2 staged files are not formatted:
            src/app.ts
            docs/notes.md (SyntaxError: Unexpected token (3:1))
          Run `npx prettier --write src/app.ts docs/notes.md`, stage them, and commit again.
✖ commit stopped by the pre-commit hook
```

The step changes no file and stages nothing. A file that is partly staged is judged as the commit holds it.

## Stage the files that nx sync writes

`Sync` runs `nx sync` and stages the files that it changed. The option `stage` names the files that the sync generators of the repo write. The default is `**/tsconfig*.json`. A repo with the Tailwind sync generator adds its style sheets:

```ts
import { Format, Sync, preCommit } from '@zukhruf/git-hooks';

await preCommit([
  new Sync({ stage: ['**/tsconfig*.json', '**/styles.css'] }),
  new Format(),
]);
```

The step does not stage a file that was changed before the hook ran, or a changed file that `stage` does not name: another session can edit the same working tree. When `nx sync` fails, the commit stops, and the hook shows the reason that nx gave.

## Build generated files

`Codegen` runs nx targets that write generated files, and stages those files. With `when`, it builds only when nx says that the staged files affect one of those projects:

```ts
import { Codegen, Format, Sync, preCommit } from '@zukhruf/git-hooks';

await preCommit([
  new Sync(),
  new Codegen({
    when: ['backend', 'frontend'],
    run: ['backend:build', 'frontend:build'],
    stage: ['openapi.json', 'packages/client/src'],
  }),
  new Format(),
]);
```

The targets run in the order that `run` gives. When a target fails, the commit stops, and the hook shows the reason that the target gave. Put `Format` after `Codegen`, so that the generated files are checked too.

## Add a step of your own

A step is a subclass of `Step`. It names itself and gives an outcome: `this.pass()`, `this.skip(why)` or `this.fail(why)`. A fail stops the commit. `Commit` reads the staged commit: `staged()`, `blob(path)`, `touches(globs)`, and `inSnapshot(work)`, which runs `work` on a copy of the staged tree in a temporary folder:

```ts
import { type Commit, Step } from '@zukhruf/git-hooks';

export class DesignCheck extends Step {
  readonly name = 'design';

  async run(commit: Commit) {
    if (!(await commit.touches(['DESIGN.md', 'apps/**/*.css'])))
      return this.skip('no design files staged');
    const valid = await commit.inSnapshot((folder) => checkDesign(folder));
    return valid
      ? this.pass()
      : this.fail('DESIGN.md disagrees with the styles');
  }
}
```
