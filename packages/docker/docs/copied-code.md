# Code copied in this package

This package keeps code that another place also has. Each copy is listed here with its source and what changed, so that a fix in one copy goes into each copy, and the commit names all of them.

| Copy                                                                                     | Source                                                      | What changed                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The `X-Registry-Auth` header in `push()` of `src/images.ts`                              | The `X-Registry-Auth` header in `pull()` of `src/images.ts` | Nothing. Both encode the credentials as JSON in padded base64url for the header, because Moby decodes it with the padded `URLEncoding` of Go. |
| The `json` writer and the route at the start of `answer` in `src/output-framing.test.ts` | The same lines in `src/output-end.test.ts`                  | Nothing in those lines; each test answers its own routes.                                                                                     | #4451 |

The `X-Registry-Auth` header is in two places of one package. This project counts places, not packages, so two places stay copies until a third place needs the header, for example a build or a login. Then the header moves into one function, and both copies go. Until then, a fix of the header goes into both places, and the commit names both (zukhruf backlog: "the X-Registry-Auth header is written twice").
