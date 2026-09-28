# yea-mcp

YEA's approval for Python MCP servers, on the official `mcp` SDK (`MCPServer`) or FastMCP 4. A job
tool returns plans instead of acting:

- **Within the person's signed policy**, the first plan runs and the call returns a receipt.
- **Outside it**, the person sees the plans in their client and types a phrase to approve one.
- **When the client can't ask**, the call returns consent codes for `yea approve`.
- **Afterwards**, anything reversible can be undone with the `undo` tool.

```python
from mcp.server.mcpserver import MCPServer
from yea import Plan, create, quantity
from yea_mcp import yea

approvals = yea(name="billing", transport="stdio")          # once per process
server = MCPServer("billing", request_state_security=approvals.request_state_security())

@approvals.job(server, risk="low", confirm_with=lambda hp, input: input["charge"])
async def refund(charge: str) -> list[Plan]:
    """Refund what is left of a charge."""
    cents = await remaining(charge)                           # reads only: the plan never acts
    return [Plan(f"Refund {cents / 100:.2f} USD of {charge}", [create("refund")],
                 apply=lambda: stripe_refund(charge, cents),
                 uses={"spend": quantity(cents, scale=2, unit="USD")})]

server.run("stdio")
```

An existing tool becomes a job without touching its code:

```python
approvals.guard(server, "delete_branch",
                describe=lambda args: {"summary": f"Delete {args['branch']}",
                                       "effects": [{"op": "delete", "target": f"branch/{args['branch']}"}]})
```

The same calls work with a `fastmcp.FastMCP` server (`pip install 'yea-mcp[fastmcp]'`).

The person's policy is a grant signed with their key and issued to this server
(`yea grant --to <approvals.service_id()>`), passed in `YEA_POLICY`. Their public key is pinned
in a file the agent can't change, named by `YEA_PRINCIPAL_PUB`.

The full contract is [SPEC-mcp-py.md](../../docs/framework/SPEC-mcp-py.md).
