# YEA Protocol

How an agent acts for a person through services, within limits the person set. [SPEC.md](SPEC.md)
is the source of truth: where this glossary disagrees with it, SPEC.md wins and this file gets
fixed.

## Language

### Consent and approval

**Consent**:
A principal's signed, one-time agreement to one exact proposal or plan, carried as a consent
grant. It is the protocol's answer to `consent_required`.
_Avoid_: approval (for the signed grant)

**Approval**:
A person's decision on a job's plan, given in the client or somewhere else (`yea approve`). An
approval given somewhere else reaches the job as a consent.
_Avoid_: consent (for the job's policy decision)

### The service side

**Verified request**:
A request whose frame has been parsed for its verb and whose proof and grants have been checked,
naming who is acting (the holder), for whom (the principal), and under which limits. It says
nothing yet about whether those limits admit a given proposal.
_Avoid_: authorized request, actor

**Commit ledger**:
A service's record of each proposal's life: proposed, committed, receipted, undone or expired.
It decides replays and whether a proposal's `each`, `risk` and `total` limits admit it.
_Avoid_: commit store, service state

**Usage ledger**:
The running amount used against each `total` limit, by grant block and measure, counting both
settled and reserved amounts. The commit ledger keeps one; a job's store keeps another.
_Avoid_: used map, spend tracker

### The agent side

**Consent round**:
What an agent does when a commit comes back `consent_required`: check that the service's request
names the proposal the agent was shown, get the person's consent to that proposal, and commit
once more with it.
_Avoid_: approval flow, consent loop

### Jobs (the framework)

**Job call**:
One call of a job tool, from the plans its handler returns to an outcome: run a plan, ask the
person, hand out a consent code, refuse, or clarify. A call that asks the person spans several
rounds of the same job call.
_Avoid_: job run, guarded call
