# A pass reads the tables that the WAL frames wrote

A pass read each table in full (ADR 0001). For the Mail import of Context Compiler (4.2 GB, about 4 million rows) a pass took about 2 minutes, also when the owner changed one row. ADR 0001 named a later option: read the page numbers of the new WAL frames, find the table of each page with `dbstat`, and read again only those tables.

Probes on that import on 2026-11-08:

- `dbstat` takes 17.5 s to give the table of each of its 1,038,283 pages, more than the 8.2 s to read its largest table. It reads each page.
- The interior pages of the b-trees list their child pages. Each page of one level of a b-tree has the type of that level, so a walk reads one child to know a level of leaves, and lists the leaves unread. It reads 1,452 pages, in about 105 ms, and gives the table of each of 445,179 b-tree pages. The other pages are overflow and free pages.
- `node:sqlite` has no `sqlite_dbpage`, so the walk reads the pages from the file, and from the WAL for a page that the WAL holds.

## Decision

- The position keeps the WAL progress of the last pass: the salt of the WAL's header and the number of frames up to its last commit.
- A pass reads the frames of the WAL before its snapshot. When the salt is the saved one and the WAL holds every frame since, the pass finds the table of each page that those frames wrote, and reads again only those tables. A commit after the frames is in the snapshot or in the frames of the next pass.
- A pass reads each table when it cannot tell what changed: the first pass, no WAL, a new salt (a reset), fewer frames than the progress, a frame that wrote a page of the schema, or a reset while the walk read the pages.
- A changed row always changes its leaf page, so a frame of an overflow page alone needs no table.

## Considered Options

- **`dbstat` at each pass.** It costs more than it saves on a large file.
- **The map of pages in the position, with a full pass at an unknown page.** The walk is cheap, so a stored map adds state and saves little.
- **The interior pages at each pass.** This option was selected.

## Consequences

- When the owner keeps its WAL, a pass after a change of one row of a small table took 20 to 38 ms in a probe, against 3.1 to 7.9 s for a full pass of the same file, with a table of 300,000 rows.
- An owner that checkpoints its WAL when it closes its last connection leaves no frames for the next pass. elt's SQLite destination does that at the end of each pass, in a sync and in a watch (probed on 2026-11-08), so its imports get full passes.
- The feed depends on the formats of the WAL and of the b-tree pages, as ADR 0001 said. Both are documented and stable.
