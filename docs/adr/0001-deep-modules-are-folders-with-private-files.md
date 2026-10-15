# A deep module is a folder with private files

A module that hides a lot behind a small interface (the consent round, the verified request, the
commit ledger, the job call session) outgrows the 300-line file limit. We keep the limit and let
such a module span files instead: an entry file `x.ts` and its folder `x/`, where only `x.ts` and
the files in `x/` may import from `x/`. `npm run lint:structure` checks it (#275). We judge a
module by the size of its interface, not by its line count, so splitting a file is never a reason
to export its parts.

## Considered options

- **Raise the limit for deep modules.** Rejected: long files are hard to review, and the rule
  would need a list of exempt modules.
- **Keep the folder pattern without a check.** Rejected, though it nearly holds today: the check
  is cheap, and it keeps callers from reaching past a deep module's entry file once one exists.

## Consequences

A private folder doesn't make an interface small on its own. Today's `approval.ts`, `ask.ts` and
`grants.ts` keep their folders private yet re-export almost every part, which is how the ordering
rules leaked into their callers. Depth comes from what an entry file chooses to export.
