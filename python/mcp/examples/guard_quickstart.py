# region quickstart
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
# endregion quickstart
