# The shadcn CLI writes the source, and the commit pins it

shadcn/ui is not a package. Its CLI downloads each item from the registry, and writes the source of the components into a repo. This package must ship that source, and it must know which source it ships.

The registry is live, and it has no versions. Its responses send `cache-control: max-age=0`. The shadcn/ui repository builds the JSON of the registry, but it does not commit that JSON: `.gitignore` excludes it. Thus `shadcn@4.21.5` pins the CLI, but it does not pin the items. The same command can write different source on a different day.

Thus the commit pins the source. The sync (`nx run shadcn:sync`) runs the CLI, and the CLI writes the generated source: `src/components`, `src/hooks`, `src/lib`, `src/index.ts` and `theme.css`. A person reads the diff, and then commits it. The build compiles only the committed source, and it needs no network.

Nobody edits the generated source by hand. The sync runs `shadcn add --overwrite`, which writes over each file. A hand edit is lost at the next sync, and nothing tells the person who made it. Thus a change goes into a place that the sync does not write:

- A change to the styles of a component is a patch in the stylesheet ([ADR 0003](./0003-the-stylesheet-registers-its-own-source-and-keeps-its-patches-in-layers.md)).
- A lint rule or a TypeScript flag that the stock code fails is off, but only for the generated source.
- Prettier formats the generated source as the last step of the sync.

## Considered Options

- **Ship a registry, and let each app run the CLI.** Each app then has a copy of the source again. The copies drift, and a fix in one copy does not go into the others. That is the problem that this package solves.
- **Build the registry of shadcn/ui from one of its git tags.** A git tag gives a version. But the build of the registry needs the Next.js app of shadcn/ui, and this workspace would have to run that app.
- **Run the live CLI in the build of this package.** The output of the build then changes from day to day, with no change in this repo. The build also needs the network.
- **Let the CLI write the source, and commit it.** This option was selected.

## Consequences

- The committed source is the version. Each build of one commit compiles the same source.
- A fix in shadcn/ui comes into this package only with a sync. A person starts the sync, and reads its diff.
- The lint and TypeScript exceptions apply only to the generated source. Code that a person writes gets all of the rules.
- A change to what a component does is a patch in `styles.css`, not an edit of the component.
- The `LICENSE` file has the MIT notice of shadcn/ui, because the package ships its source.
