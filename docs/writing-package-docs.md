# How to write the docs of a package

Each `@zukhruf/*` package keeps its docs beside its code. This guide gives the kinds of doc, the shape of each kind, the style, and the commit. People and agents follow it. The `/update-docs` skill follows it with no person present, so each rule is one that a reader can check in the file. Each shape names one file that already has it.

## The kinds of doc

The kinds follow [Diátaxis](https://diataxis.fr/), which sorts docs into tutorials, how-to guides, reference and explanation. The decision records follow Michael Nygard's [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) (2011), with the `Considered Options` section of [MADR](https://adr.github.io/madr/). The glossary is the ubiquitous language of one bounded context, from Eric Evans, _Domain-Driven Design_ (2003).

| Kind                  | Path in the package                                   | What it is for                                                                                                                                                                              | Diátaxis                   |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| README                | `README.md`                                           | The entry page: what the package does, a task section for each use, the errors, and links to the other docs.                                                                                | how-to guide and reference |
| Glossary              | `CONTEXT.md`                                          | One meaning for each word of the package, and the words to avoid.                                                                                                                           | reference                  |
| Concept               | `docs/concepts/<topic>.md`                            | How one idea of the package works, and why.                                                                                                                                                 | explanation                |
| Recipe                | `docs/recipes/<task>.md`                              | One use case, solved with a full program that runs.                                                                                                                                         | how-to guide               |
| Reference page        | `docs/<group>/<name>.md`                              | One page for each member of a family, in one fixed shape ([memory-store.md](../packages/mutex/docs/stores/memory-store.md)).                                                                | reference                  |
| Decision record (ADR) | `docs/adr/NNNN-<title>.md`                            | One decision of the owner, its reason, and the options that lost.                                                                                                                           | explanation                |
| Index                 | `docs/README.md`                                      | A list of all docs of the package.                                                                                                                                                          | none                       |
| Copy ledger           | `docs/copied-code.md`, `docs/copied-from-<source>.md` | Each copy of code, as the Rule of Three asks. [tools/copy-check](../tools/copy-check/src/copy-ledgers.ts) reads `**/docs/copied-*.md` and owns their content. This guide does not cover it. | none                       |

The workspace also has two root files. [CONTEXT-MAP.md](../CONTEXT-MAP.md) has one row for each context. [docs/adr](./adr) holds the decisions that apply to more than one package, such as [ADR 0004](./adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md).

## README

Example: [packages/election/README.md](../packages/election/README.md).

````md
# @zukhruf/<npm name>

<What the package does, in one or two paragraphs.>

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it <!-- the install command, then the smallest program -->

## <Task sentence> <!-- one section for each use, in the order a reader needs them -->

## Errors <!-- a table: | Error | When | -->

## What the package does not do

## The same concepts in other systems <!-- a table: | Concept | Other systems | -->

## API <!-- one ```ts block of the public types -->

## Documentation <!-- links to the concepts, recipes, ADRs and copy ledger -->

## Development <!-- the nx commands and the src/ layout -->
````

- The title is the npm name: `# @zukhruf/sqlite-open` for the folder `packages/sqlite/open` ([README](../packages/sqlite/open/README.md)).
- A task section title is an imperative sentence: "Install a job", "Send a process signal" ([launchd](../packages/launchd/README.md)), "Lend a worker to a job" ([pool](../packages/pool/README.md)).
- A fixed section has a fixed title: `## Use it`, `## Errors`, `## What the package does not do`, `## The same concepts in other systems`, `## API`, `## Documentation`, `## Development`. Write only the sections that have content. Keep the order above.
- `## Errors` lists each error class that a caller handles differently, in a table with the columns `Error` and `When` ([sqlite-queue](../packages/sqlite/queue/README.md)). launchd and docker use the title "Catch the errors that change what you do next" for the same section.
- `## What the package does not do` is a list. Each item starts with a bold sentence, then gives the reason or the ADR ([launchd](../packages/launchd/README.md)).
- `## The same concepts in other systems` names each system with its file, line or link ([docker](../packages/docker/README.md)).
- `## Documentation` links each concept, each recipe and each ADR. When it links more than one kind, group the links under the bold labels `**Concepts**`, `**Recipes**` and `**Decisions**` ([mutex](../packages/mutex/README.md)). A recipe link drops the word "Recipe:". An ADR link is `- [ADR NNNN](./docs/adr/NNNN-….md): <title, first word in lower case>.` ([pool](../packages/pool/README.md)). pool and relevance-filtering write `## Recipes` and `## Decisions` as two sections; this is allowed.
- `## Development` is optional. Write it when the package has more to say than the standard targets: tests that run from `src/`, a native build ([sqlite-open](../packages/sqlite/open/README.md)).
- The `description` in `package.json` is the one home of the package's row in the root [README.md](../README.md). `npx nx run readme-table:generate` writes that table ([tools/readme-table](../tools/readme-table/src/packages-table.ts)). Do not edit the row by hand.

## Glossary: CONTEXT.md

Examples: [packages/mutex/CONTEXT.md](../packages/mutex/CONTEXT.md) (with groups), [packages/launchd/CONTEXT.md](../packages/launchd/CONTEXT.md) (with sources).

```md
# <Context name>

<One short paragraph: what the context is.>

## Language

### <Group> <!-- optional -->

**Term**:
<Definition: what the term is, in one to three sentences.>
_Avoid_: Word, other word (the reason, when one is useful)
```

- Each entry is `**Term**:` on its own line, then the definition, then `_Avoid_: …` as its last line. A definition can hold a list ("Domain" in launchd). One blank line separates two entries.
- When a definition takes a word from a standard, cite it in the definition: a man page and its lines ("launchd.plist(5), lines 64-65"), or the upstream doc.
- An `_Avoid_` item can carry its reason in parentheses: "Plist (the format of the file)".
- Other `##` sections are rare (pool's "The pool for the computer", shutdown's "Relationships"). Add one only for terms that need a common frame.

## Concept

Examples: [packages/mutex/docs/concepts/fencing-tokens.md](../packages/mutex/docs/concepts/fencing-tokens.md), [packages/election/docs/concepts/leader-election.md](../packages/election/docs/concepts/leader-election.md).

```md
# <Concept name, or a sentence: "How SqliteElection elects a leader">

<Context: one paragraph, with the term in bold where it is defined.>

## <Topic> <!-- as many as the concept needs -->

## Evidence <!-- the last section: one bullet for each test or source, with what it proves -->
```

- An Evidence bullet names the file and the fact: "`src/testing/contract/single-process.ts`: tokens increase in the order of the grants."

## Recipe

Examples: [packages/pool/docs/recipes/warm-a-model-once.md](../packages/pool/docs/recipes/warm-a-model-once.md) (output to compare), [packages/single-flight/docs/recipes/join-a-run-in-flight.md](../packages/single-flight/docs/recipes/join-a-run-in-flight.md) (a mechanism to explain).

````md
# Recipe: <Imperative sentence>

**Use case.** <The situation, the problem, and what goes wrong without the package.>

**What you need.** <The inputs: the classes, a model, a server.>

## The steps

1. <One instruction.>
2. <One instruction.>

## The program

<One or two sentences: what the program does.>

```ts title="<file>.ts"
<the full program>
```

Output:

```
<the real output of one run>
```

## What the output shows <!-- or: ## Why it works -->

## Things to know

- **<A bold sentence.>** <The detail, with a link to the ADR or README section.>
````

The rules:

1. The program runs as written. It has all its imports and no `...`. It needs no file that the recipe does not give.
2. The output is the real output of a run of that program. Run it, and paste what it printed. Never write output by hand. Precedent: commit `f887b0b9`, "the recipe test-a-pool-on-the-real-path.md teaches the fake clock, with its real output".
3. When the output changes from run to run or from machine to machine, say how it was made in the line before the block: "Output on a Mac with 14 CPUs, while other programs also ran:" ([find-how-many-workers-pay.md](../packages/pool/docs/recipes/find-how-many-workers-pay.md)), "Output (the time changes from run to run):" ([survive-a-crashed-holder.md](../packages/mutex/docs/recipes/survive-a-crashed-holder.md)). Name the model and the server version when a model makes the output ("EmbeddingGemma 2 Q8_0 on llama.cpp b11960").
4. When you change the program, run it again, and paste the new output.
5. Write `## What the output shows` when the lesson is in the numbers. Write `## Why it works` when the lesson is the mechanism.
6. A program that needs a server first gives its start command in a ```sh block before the program ([filter-a-feed-with-a-taught-profile.md](../packages/information-filtering/relevance-filtering/docs/recipes/filter-a-feed-with-a-taught-profile.md)).

The allowed variants:

- `**Lock store.** …` in place of `**What you need.** …`, in the mutex recipes, where the lock store is the one input to choose.
- `## Select a lock store` in place of `## The steps`, when the step is a choice ([several-instances-on-one-host.md](../packages/mutex/docs/recipes/several-instances-on-one-host.md)).
- `## The problem` with a broken program and its output, then `## The solution` with the fixed one ([reserve-the-last-item.md](../packages/mutex/docs/recipes/reserve-the-last-item.md)).
- `## The rules`, `## Example 1: …`, `## Example 2: …` and a test section, for a recipe that implements an interface ([write-your-own-lock-store.md](../packages/mutex/docs/recipes/write-your-own-lock-store.md)).
- Extra topic sections before `## Things to know` ("Why not `navigator.locks`"), and `## Next steps` at the end.

## Decision record (ADR)

Examples: [packages/async/docs/adr/0006](../packages/async/docs/adr/0006-a-timeout-is-a-signal-on-the-clock-that-the-caller-gives.md) (status lines, `## Decision`), [packages/mutex/docs/adr/0017](../packages/mutex/docs/adr/0017-a-connection-closes-only-when-its-framing-breaks.md) ("Thus"), [packages/election/docs/adr/0007](../packages/election/docs/adr/0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md) (proposed).

```md
# <The decision, as a sentence>

<Status paragraph, only when one applies: line 3.>

<Context: the problem and the facts, as prose or a list. No heading.>

## Decision

<The decision, first sentence; then its details.>

## Considered Options

- **<Option.>** <Why it lost.>

## Consequences

<What changes, what it costs, what stays open.>
```

- The file is `docs/adr/NNNN-<title in lower case, words joined by hyphens>.md`. The numbers count from `0001` in each package. A new ADR takes the highest number plus one. A number is never used again.
- Write the decision under `## Decision`. Older ADRs give it in a paragraph that begins "Thus …", after the context. Do not rewrite them.
- A status paragraph starts on line 3. When there are more, the newest comes first. The forms are:
  - `Superseded on <date> (#NNNN) by [ADR NNNN](./NNNN-….md): <what is now true>.` Add "for <part>" when the rest stays true ([diagram 0001](../packages/diagram/docs/adr/0001-the-diagram-is-a-zukhruf-package.md)).
  - `Superseded in part on <date> (#NNNN) for <part>. <What is now true> ([ADR NNNN](./NNNN-….md)).`
  - `Status: Proposed <date> for the owner's review (backlog #NNNN).`
- To change a decision, write a new ADR. Add a status paragraph to the old one, and keep its text. Mark it in the README list: "(superseded by ADR 0014)" ([mutex docs/README.md](../packages/mutex/docs/README.md)).
- **An ADR records a decision of the owner, in the owner's own words.** Quote those words when they decide it, as [election 0007](../packages/election/docs/adr/0007-a-candidate-waits-on-pushes-from-the-leaders-pipe-not-on-a-period.md) does. An agent never records its own recommendation as a decision. Without the owner's words, the ADR has the status `Proposed`.
- A decision for more than one package goes in the root [docs/adr](./adr), numbered there.

## Index and map

- `docs/README.md` ([mutex](../packages/mutex/docs/README.md)) has the title `# Documentation`, the line `Start with the [project README](../README.md). The glossary is in [CONTEXT.md](../CONTEXT.md).`, then `## Concepts`, one section for each reference group, `## Recipes` (numbered), `## Architecture decision records` (numbered, by title) and `## Copied code`. When a package has one, keep it in step with the README. Do not add one to a package that has none.
- The README lists each recipe and each ADR of the package (see README above).
- [CONTEXT-MAP.md](../CONTEXT-MAP.md) has the columns `Context`, `Glossary` and `Decisions`. Each package with a `CONTEXT.md` has one row. The `Glossary` cell links the `CONTEXT.md`. The `Decisions` cell links the `docs/adr` folder, or says `None`.

## Style

The style is the one of the `wait-what` skill: "give me a little bit of context, talk in ASD-STE100 Simplified Technical English, and use the ubiquitous language".

- Give a little context first: one or two sentences that say what the page is about, before any detail.
- Write [ASD-STE100](https://www.asd-ste100.org/) Simplified Technical English. Use short sentences and the active voice. Write one instruction in each sentence. Give each word one meaning.
- Use the words of the package's `CONTEXT.md`. Do not use its `_Avoid_` words.
- Write the titles of task sections, recipes and ADRs as sentences. A concept, a reference page or a fixed section can have a name as its title ("Reach", "Errors").
- Cite the evidence for each claim: an issue (`#3527`), a commit, a man page and its lines, an upstream doc with a link, or a test file.
- Use the term of the industry, with its source. When no term fits and you make one, say so in the same sentence.

## Commit

```
docs(<nx project name>): <the fact that the doc now says, a sentence in lower case> (#NNNN)
```

- The scope is the Nx project name, as `npx nx show projects` lists it: `sqlite-notify`, not `sqlite/notify`.
- A commit that changes only root files has no scope: `docs: …`.
- Do not write a second "): " after the scope. nx release reads the scope up to the last "): ", and the commit-msg step [NxReleaseScope](../packages/git-hooks/src/nx-release-scope.ts) refuses such a subject. Write "(#3840); " in its place.
- A `docs` commit changes no version: the nx default is `docs: { semverBump: 'none' }`.

Real subjects:

```
a673db23 docs(pool): ADR 0017 sets superviseIntervalSeconds 1 beside monitorIntervalSeconds 1, because sqlite-queue's monitor runs only inside a supervise pass (#3527)
465867dd docs(sqlite-notify): the README says the pool's new-job notification carries the revision of the job, as pool ADRs 0018 and 0022 decide (#3527)
```

## Before you hand off

1. Each relative link resolves to a file.
2. Each recipe program ran, and its output block is the output of that run.
3. Each new recipe, concept and ADR has a link in the README, and in `docs/README.md` when the package has one.
4. `npx prettier --check <each changed file>` passes. Run Prettier by path, never on the whole tree.
