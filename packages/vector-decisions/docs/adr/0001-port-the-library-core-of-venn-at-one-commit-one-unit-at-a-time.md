# Port the library core of Venn at one commit, in one private package, one unit at a time

Status: Accepted (Ezz, 2026-11-10, 2026-11-11 and 2026-11-14).

## Context

A program often needs a decision about a text, not new text: which team owns a ticket, how urgent it is, or if it is a defect. A decision model such as Jev reads the text again for each question. Venn (`venn-vdm`, MIT, by Mark Russinovich) answers the same typed questions from vectors. A reader (EmbeddingGemma 2) embeds each text one time. Then a small head (`venn-1`, 787,457 parameters) compares the vector of the text with the vectors of the options. Venn is a Python package on PyTorch. This repository has no TypeScript form of it.

A probe of 2026-11-10 (backlog #4251) ran the head of Venn in TypeScript on 125 labelled texts. With described options, it gave an average precision of 0.890. With only "Yes." and "No." before the question, it gave 0.121, which is near chance. So the head works when the options carry the meaning.

Ezz chose:

- the visibility: "Private" (2026-11-10);
- the name: "@zukhruf/vector-decisions" (2026-11-11);
- the scope: "Library core only" (2026-11-11);
- the order of work: "can we build this part by part and you teach me each part. think of the parts as compopslbe unites that stitched together form the goal" (2026-11-14).

## Decision

1. The package ports the library core of Venn 0.1.0 at commit `7b2042e84608fbdd143ac21dea7c83d5ae2ec723` (2026-11-13). The port started from `ad97513`. The five later commits add an opt-in batch path for prepared Choice questions and more checks of outcome stores, so the port moved to the newer commit before it had code.
2. The core is: the decide path (Choice, Score, Noul, IndexApply, prepared questions), calibration, NearestReference, SetMembership, PopulationShift, the families (linear Choice, residual Choice, ridge and kernel ridge regression), the OutcomeService, a reader on Transformers.js, and an AI SDK decision model in place of Venn's Decisions API. The package does not port the HTTP server, the MCP server, the six vector-store adapters, or image and audio input.
3. Each part keeps the name that Venn gives it, in camelCase, and its documentation names its Venn source file. The documentation marks each part that Venn does not have as an addition of this package.
4. The package does not ship weights. It downloads the `venn-1` head at revision `e618a6919e5a15c6ced46c9874424363c2955283` and checks each file against its SHA-256. The model card of the head permits redistribution and says nothing more about use, so the package stays private.
5. The package is built in units. Each unit works and has tests alone, and it composes with the units before it. The README lists the units and their state.
6. Golden tests compare the package with Venn's own Python at the same commit, on the same input vectors. A part that trains by small steps from a random start (the residual Choice family and the outcome heads) can only match Venn in quality, because its start depends on the random generator of PyTorch.

## Consequences

- A later commit of Venn is a new decision: compare its core with this port, then move the pin and the golden tests together.
- The heads that train by small steps need gradients. This package writes them by hand for its few fixed modules (a later ADR).
- The optimizer that linear Choice and calibration need moves out of mteb into its own package, because a second package now imports it.
