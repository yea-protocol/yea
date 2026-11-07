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
The decision that lets a job's plan run outside the policy, given in the client's form or
somewhere else (`yea approve`). An approval given somewhere else reaches the job as a consent.
Whether a person made it depends on its tier: the form tier or signed consent (SPEC-approval
§9).
_Avoid_: consent (for the job's policy decision)

**Form tier**:
An approval produced inside the chat client: an answer to the approval form whose typed phrase
matches the plan's, or anything else that answer triggers, a signature included. It proves only
what the client stack attests, and MCP attests nothing about a person, so hooks, models or
scripts may have answered (SPEC-approval §9).
_Avoid_: verified approval, in-client consent

**Signed consent**:
The approval tier above the form: a consent signed with the principal key outside the chat
client, by `yea approve`. It proves the key's holder signed that exact plan, and that a person
acted only when the key and the prompt that triggers the signing are both out of the agent's
reach.
_Avoid_: strong approval (unqualified)

**Client call prompt**:
Claude Code's own permission prompt for a tool marked
`_meta["anthropic/requiresUserInteraction"]`, which YEA's acting tools carry when the opt-in
`requireInteraction` option is on (#338). It shows that whoever answered the prompt allowed that
call with those arguments, not which plan they chose in the form.
_Avoid_: client approval

### The service side

**Verified request**:
A request whose frame has been parsed for its verb and whose proof and grants have been checked,
naming who is acting (the holder), for whom (the principal), and under which limits. It says
nothing yet about whether those limits admit a given proposal.
_Avoid_: authorized request, actor

**Commit ledger**:
A service's record of each proposal's life: proposed, committed, receipted, undone, expired, or
in doubt when its commit was cut off after it started and may have taken effect. It decides replays
and whether a proposal's `each`, `risk` and `total` limits admit it.
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

**Approver**:
Whoever a consent round asks for the person's consent. It gives a consent grant, declines, or
hands back a consent code to approve somewhere else.
_Avoid_: signer (for the role), consent provider

**Consent store**:
Where an agent keeps consents given somewhere else, by the proposal they commit. A consent round
looks there before asking the person.
_Avoid_: consent cache, consents dir

**Job consent**:
A person's consent to one job plan, given somewhere else (`yea approve`) and kept by plan hash
in the job's store, where the job's server looks for it on the next identical call. The
consent store keeps the other kind: consents to one proposal, for an agent's consent round.
_Avoid_: consents dir (for either), round consent

**Consent hash**:
What a job consent binds: the plan hash and the phrase the tool names for it (after the
`approve` fallback), hashed together (SPEC-approval §6). It is a job consent code's `hash` and
the consent grant's `only`, so a consent signed for an edited phrase never runs. The plan hash,
the code's `proposal`, stays what the job's store keeps the consent by.
_Avoid_: phrase hash, code hash

**Tool host**:
The module that gives an AI agent YEA tools. It is on the agent's side, so it must be handed the
agent's side of the home only, never the principal key, and can't sign for the agent. A
person-facing loop that drives one, such as the test drive's, asks the person and signs outside it.
_Avoid_: harness

### Jobs (the framework)

**Job call**:
One call of a job tool, from the plans its handler returns to an outcome: run a plan, ask the
person, hand out a consent code, refuse, or clarify. A call that asks the person spans several
rounds of the same job call. The SDK runs it as a **job call session**, one step per round; the
MCP packages carry the state between rounds and turn each outcome into a result.
_Avoid_: job run, guarded call
