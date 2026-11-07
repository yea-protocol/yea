# yea-mcp

**Guard a risky tool in your Python MCP server with one call**, on the official `mcp` SDK
(`MCPServer`) or FastMCP 4. Before the tool runs, your server sends the client its plan as a
form (MCP form elicitation), and the tool runs only when the form comes back with the right
phrase typed in: approval in the client. The plan is your server's, computed from the call's
input, and it fails closed. A form proves only what the client attests, so plans that need a
signature go at `risk="high"`, which replaces the form with a consent code for the person to
sign with `yea approve`, outside the chat
([what an approval proves](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-approval.md#what-an-approval-proves)).

> **Unreleased:** `yea-mcp` isn't on PyPI yet. Until it is, install it and `yea-sdk`, which it
> depends on, from the repo:
>
> ```sh
> uv add "yea-sdk @ git+https://github.com/yea-protocol/yea#subdirectory=python" \
>        "yea-mcp @ git+https://github.com/yea-protocol/yea#subdirectory=python/mcp"
> ```

```sh
uv add yea-mcp  # or: pip install yea-mcp. With FastMCP: 'yea-mcp[fastmcp]'
```

<!-- snippet: python/mcp/examples/guard_quickstart.py#quickstart -->
```python
"""An MCP server whose ``send_email`` shows its plan and waits for approval.

    uv run python guard_quickstart.py
"""

import sys

from mcp.server.mcpserver import MCPServer

from yea_mcp import Approvals, yea


def create_server(approvals: Approvals) -> MCPServer:
    # request_state_security lets YEA seal the approval state it sends round the client.
    server = MCPServer("mail", request_state_security=approvals.request_state_security())

    # Your tool, registered as usual. This one only logs.
    @server.tool(description="Send an email")
    def send_email(to: str, subject: str) -> str:
        print(f"email {to}: {subject}", file=sys.stderr)  # stdout is the MCP transport
        return f"sent to {to}"

    def describe(args: dict) -> dict:
        return {"summary": f"Email {args.get('to')}: {args.get('subject')}",
                "effects": [{"op": "send", "target": str(args.get("to"))}]}

    # One call: now it shows its plan and waits for approval before it runs.
    approvals.guard(server, "send_email", describe=describe,
                    confirm_with=lambda plan, args: str(args.get("to")))  # type the recipient
    return server


if __name__ == "__main__":
    create_server(yea(name="mail", transport="stdio")).run("stdio")  # one yea() per process
```

Save it as `server.py` in your project, and in that folder add it to Claude Code with
`claude mcp add mail -- uv run python server.py`. Then ask Claude to email ana@example.com about
the Q3 report. Before anything is sent, Claude Code shows the plan, such as
*Email ana@example.com: Q3 report*, and a field that says *Type "ana@example.com" to approve*.
It needs no keys, policy or account to set up. The same calls work on a `fastmcp.FastMCP`
server.

## Next

- **The guide**, [Add YEA to your MCP server](https://yea-protocol.github.io/yea/guide/mcp-python),
  turns a tool into a job that returns plans, with undo, a signed policy that lets undoable plans
  run on their own, and consent codes for clients that can't show forms.
- **The spec** is [SPEC-mcp-py.md](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-mcp-py.md),
  and [SPEC-approval.md](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-approval.md)
  for how a call is approved.
- **In TypeScript**, the same server uses
  [`@yea-protocol/mcp`](https://www.npmjs.com/package/@yea-protocol/mcp).
