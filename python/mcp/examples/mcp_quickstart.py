"""A small `files` MCP server with YEA approval: the example in the "Add YEA to your MCP server"
guide for Python (site/guide/mcp-python.md). The guide shows its regions in order, and
python/mcp/tests/test_quickstart.py drives them with in-memory clients.

    FILES_ROOT=~/scratch uv run python examples/mcp_quickstart.py
"""

# region imports
import os
import uuid
from pathlib import Path

from mcp.server.mcpserver import MCPServer
from yea import Plan

from yea_mcp import Approvals, yea

# endregion imports


# region root
def inside(root: str, path: str) -> Path:
    """``path`` inside ``root``. Anything that leads outside is refused, so the tools can't reach
    the server's own files (its key, its approval store) or yours; so is a symlink as the file
    itself, so the plan the person approves always names the file that changes."""
    base = Path(root).resolve(strict=True)
    if (base / path).is_symlink():
        raise ValueError(f"{path} is a symlink")
    full = (base / path).resolve(strict=True)
    if full == base or base not in full.parents:
        raise ValueError(f"{path} is outside {base}")
    return full


# endregion root


# region guard
def add_delete_file(server: MCPServer, approvals: Approvals, root: str) -> None:
    """Your existing tool, registered as usual, then guarded."""

    @server.tool(description="Delete a file for good")
    def delete_file(path: str):
        inside(root, path).unlink()
        return f"deleted {path}"

    def describe(args: dict) -> dict:
        path = str(args.get("path"))
        if not inside(root, path).is_file():  # refuse before anyone is asked
            raise ValueError(f"{path} is not a regular file")
        return {"summary": f"Delete {path}", "effects": [{"op": "delete", "target": f"file/{path}"}]}

    # One call: now it shows its plan and asks the person before it runs.
    approvals.guard(server, "delete_file", describe=describe,
                    # The person types the file's name to approve.
                    confirm_with=lambda plan, args: Path(str(args.get("path"))).name)


# endregion guard


# region job
def add_move_to_trash(server: MCPServer, approvals: Approvals, root: str) -> None:
    """A job written for YEA: the undoable way to get rid of a file."""

    def revert(receipt: dict, ctx) -> None:
        file, trashed = receipt["result"]["file"], receipt["result"]["trashedAs"]
        # Fails, and changes nothing, if a new file took the old one's place. It needs hard links,
        # which some filesystems (exFAT, some network mounts) don't have: undo fails there.
        os.link(trashed, file)
        os.unlink(trashed)

    # With revert and an undo window, the plan is undoable: YEA adds an `undo` tool.
    @approvals.job(server, risk="low", revert=revert)
    def move_to_trash(path: str) -> list[Plan]:
        """Move a file to the trash. It can be undone for a day."""
        file = inside(root, path)  # the plan only reads
        if not file.is_file():  # revert can't put back a directory, so refuse one here
            raise ValueError(f"{path} is not a regular file")

        def apply() -> dict:
            trash = file.parent / ".trash"
            trash.mkdir(exist_ok=True)
            trashed = trash / f"{uuid.uuid4()}-{file.name}"
            file.rename(trashed)
            return {"file": str(file), "trashedAs": str(trashed)}  # what revert gets back as `result`

        return [Plan(f"Move {path} to the trash", [{"op": "update", "target": f"file/{path}", "detail": "moved to .trash"}],
                     apply=apply, undo_window=86_400)]  # one day, in seconds


# endregion job


# region serve
def create_server(approvals: Approvals, root: str | None = None) -> MCPServer:
    """The server, with both tools. ``root`` is the only folder the tools touch."""
    root = root or os.environ.get("FILES_ROOT") or os.getcwd()
    # request_state_security lets YEA seal the approval state it sends round the client.
    server = MCPServer("files", request_state_security=approvals.request_state_security())
    add_delete_file(server, approvals, root)
    add_move_to_trash(server, approvals, root)  # step 4
    return server


# endregion serve

if __name__ == "__main__":
    # region start
    approvals = yea(name="files", transport="stdio")  # once per process
    create_server(approvals).run("stdio")
    # endregion start
