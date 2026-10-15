# A verified request checks identity; the commit ledger checks limits

A service checks a request in two places. The verified request checks the proof, the grant
chain, the principal, the requester and every caveat except `each`, `total` and `risk`. The
commit ledger checks those three against the proposal, after looking for a replay. SPEC.md §4.4
says a replay is authorized like a commit but never re-evaluates `each`, `total` or `risk`, and
only the commit ledger knows whether a commit is a replay. Checking `total` there also lets the
check and the reservation happen in one synchronous step, so concurrent commits can't both pass.

## Consequences

Don't move limit checks back into authorization: that brings back a replay that has to fake an
authorization to skip them, and a `total` checked twice. Grant evaluation stays one function,
covered by `conformance/grants.json`; the commit ledger calls it with the limits included.
