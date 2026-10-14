Closes #   <!-- or "Part of #n" when the issue spans several PRs -->

## Summary
<!-- The smallest view that makes the change clear: a before/now pair, a diff sketch,
     a call tree, or the wire lines that change. -->

## Evidence
<!-- Before and after: a screenshot for site/, a test that failed and now passes, CLI output.
     End with the checks you ran. -->

## Merge danger
**Door:** <!-- one-way or two-way -->

**Blast radius:**
<!-- One-way if it changes bytes on the wire or Lens output, a published package's API,
     or anything outside the repo (labels, secrets, deploys, the demo worker).
     Blast radius: who or what breaks if this is wrong. -->

## Checklist
<!-- Delete lines that don't apply. CI already runs lint, tests and the vector drift check. -->
- [ ] Wire or Lens change: SPEC.md updated, vectors regenerated, landed in both ts/ and python/
- [ ] Security fix: regression test in ts/test/security.test.ts or mcp/test/bridge-security.test.ts
- [ ] Theme tokens changed: .agents/context/DESIGN.md updated
- [ ] Behavior users see changed: docs and README updated
