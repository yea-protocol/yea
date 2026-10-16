# The principal key never joins an agent-side home

The YEA home holds the agent's side: the agent key, its grants and consents, the policy, the
approval store and the servers' seeds. Unless `YEA_PRINCIPAL_HOME` moves it elsewhere, it holds
the principal key too. The 2026-10-15 review of the agent side (#294) considered one home object,
passed to every reader, that would load any of these. `ts/src/tools/commit.ts:53` showed the
risk: test-drive's tool host loads the principal key inside the agent's tools, so a tool host
that can reach the key can sign for the agent.

Only person-facing commands create the principal key or sign with it: `init`, `install`,
`grant`, `approve`, `talk`, and test-drive's person loop. Four more load it only to read its
public half, and never sign: `whoami` and `doctor` report on it, and `examples` and `openapi`
trust it. A home that code on the agent side is given holds the agent's side only: a tool host,
the bridge, a server and `yea()` never load the principal key from it. So the home stays a
directory option (`yea({ home })`, `bridge({ home })`), not an object with key loaders.

## Considered options

- **One home object with key loaders** (candidate 6 of the review). Rejected: it would hand the
  principal key's loader to every reader of the home, the agent side included, and the only
  thing keeping a tool host from signing would be that it doesn't call it.

## Consequences

Once #299 lands, AGENTS.md rule 3 (never sign with the principal key on an agent's behalf)
holds by construction: code on the agent side has no way to reach the key, rather than a rule
not to. Until then test-drive's tool host is the exception: it loads the principal key inside
the agent's tools. #299 removes it: test-drive drives the bridge and approves in its own loop,
as the person.

The home helpers that `@yea-protocol/sdk/node` exports (`home`, `agentKey`, `loadGrants`,
`saveGrant`, `loadConsent`, `homeConsents`) stay public, as SPEC-mcp-ts documents them. None of
them loads the principal key, and `principalKey` is not exported from any of the SDK's entry
points.
