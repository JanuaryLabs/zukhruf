# A keyword is a word start or a regular expression

The reader types keywords next to the description of a profile. The research used one case-insensitive Python regular expression for each profile (`keywords.json`, `narrow`), for example `secur` and `\bchips?\b|semiconductor`. A reader types words, not regular expressions. The package must decide how a typed word matches the title and the lead of an article.

## Decision

A keyword is a string or a `RegExp`.

- **A string matches at the start of a word, in any case.** `secur` matches "Security" and "securing", but not "cybersecurity". A letter, a digit or `_` before the keyword stops a match. The other characters of the keyword match as they are.
- **A `RegExp` matches as it is.** The eval gives the regular expression of the research for each profile, so it reproduces the research. A host can give a regular expression for a pattern that a word start cannot say. The filter uses `String.prototype.search`, so the `g` and `y` flags and `lastIndex` have no effect.
- An article matches when one keyword of the profile matches its text.

## Considered Options

The research's narrow regular expressions were compared with three rules for the same words, on the 8,064 articles of the collection and the two fresh slices (16 profiles, 2026-10-29):

| Rule                                    | Articles where the rule and the research disagree |
| --------------------------------------- | ------------------------------------------------- |
| Word start (selected)                   | 272                                               |
| Anywhere in the text                    | 973                                               |
| A whole word, with up to 2 more letters | 1,388                                             |

- **Anywhere in the text.** `code` then matches "codex" and "encode", and the coding profile disagrees on 927 articles.
- **A whole word.** `secur` then matches nothing, and the security profile disagrees on 912 articles.
- **Word start.** Most of its disagreements are compound words: "cybersecurity" for `secur` (122) and "codex" for `code` (72). The reader can type the second word too.

## Consequences

- The eval gives the research's regular expressions, and its results are those of the research.
- The README tells the reader to type each part of a compound word.
- A `RegExp` cannot be stored as JSON. A host that stores profiles as JSON stores strings.
