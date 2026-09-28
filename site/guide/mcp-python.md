# Add YEA to your MCP server (Python)

You have an MCP server, and one of its tools does something a person should see first: it deletes a file, sends an email, or moves money. This guide adds YEA to that tool. Before the tool runs, the server asks the person, through their client, to approve its plan by typing a phrase. The model can't approve it through the tool call. What else must stay out of the agent's reach, such as your client's config, is in the [security model](/guide/security#mcp-servers-built-with-the-framework).

Steps 1–3 give you that tool, and need no keys, no policy and no account. Steps 4–6 are separate, later steps: undo, letting safe things run on their own, and clients that can't ask.

The code on this page comes from [`python/mcp/examples/mcp_quickstart.py`](../../python/mcp/examples/mcp_quickstart.py), a small `files` server that the test suite runs. It uses the official Python MCP SDK (`MCPServer`); [FastMCP](#fastmcp) works the same way.

## 1. Install

::: warning Unreleased: install from the repo
`yea-mcp` and `yea-sdk` aren't on PyPI yet. Until they are, install both from the repo into your server's project (`yea-mcp` depends on `yea-sdk`, so both come from git):

```sh
uv add "yea-sdk @ git+https://github.com/yea-protocol/yea#subdirectory=python" \
       "yea-mcp @ git+https://github.com/yea-protocol/yea#subdirectory=python/mcp"
```

Steps 5 and 6 also use the `yea` command, which ships with the TypeScript packages. From a clone: `git clone https://github.com/yea-protocol/yea ~/yea && cd ~/yea && npm ci && npm run build`, then `alias yea="node $HOME/yea/cli/bin/yea.js"`.
:::

`yea-mcp` works with the official `mcp` SDK 2.2 or later and Python 3.10 or later.

## 2. Guard one tool you already have

Here is the whole change. `delete_file` is registered exactly as before, and one `approvals.guard(...)` call turns it into a tool that shows its plan and asks. The snippets below, in order, are a complete `server.py`:

<<< ../../python/mcp/examples/mcp_quickstart.py#imports

The example's tools only touch files inside one folder, so a mistaken or hostile path can't reach anything else, including the server's own key and approval store. That folder comes from `FILES_ROOT`, which must be set and must not hold the server's own files:

<<< ../../python/mcp/examples/mcp_quickstart.py#root

<<< ../../python/mcp/examples/mcp_quickstart.py#guard

- **`describe(args)`** says what the call will do: a one-line `summary` and its `effects`. It must not change anything. Its `args` are the raw arguments, before the tool validates them, so convert fields with `str(...)`.
- **`confirm_with`** names the phrase the person types, here the file's name. Without it, the phrase is `approve`. It must be typeable: a phrase with control or invisible characters, or a tab or other unusual space inside, is refused as a tool error.
- **`guard` takes the tool's name.** It installs YEA's check on that server, so a guard can't be forgotten or attached to the wrong one.

Build the server. Leave out the `add_move_to_trash` line until step 4:

<<< ../../python/mcp/examples/mcp_quickstart.py#serve

`request_state_security` lets YEA seal the approval state it sends round the client. Then check `FILES_ROOT` (the server refuses to start with a message saying what to set), create the approval context once per process, and serve:

<<< ../../python/mcp/examples/mcp_quickstart.py#start

::: details Show the full file
<<< ../../python/mcp/examples/mcp_quickstart.py
:::

## 3. Run it in your client

The tools only act inside `FILES_ROOT`, so give them a folder of files you can lose. The server refuses to start without it, or when it holds the server's own files, since `delete_file` could then remove your project's files, such as `server.py` and `pyproject.toml`. Make the folder, with a file for step 3 to delete and one for step 4 to move to the trash:

```sh
mkdir -p "$HOME/yea-scratch/docs"
echo "Q3 report" > "$HOME/yea-scratch/docs/report.pdf"
echo "meeting notes" > "$HOME/yea-scratch/docs/notes.txt"
```

Then, in **Claude Code**, from your server's project folder:

```sh
claude mcp add files -e FILES_ROOT="$HOME/yea-scratch" -- uv run python server.py
```

::: details Cursor and VS Code
**Cursor**, in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "files": {
      "command": "uv",
      "args": ["run", "--directory", "/absolute/path/to/project", "python", "server.py"],
      "env": { "FILES_ROOT": "/absolute/path/to/yea-scratch" }
    }
  }
}
```

**VS Code**, in `.vscode/mcp.json`. The top-level key is `servers`:

```json
{
  "servers": {
    "files": {
      "type": "stdio",
      "command": "uv",
      "args": ["run", "--directory", "${workspaceFolder}", "python", "server.py"],
      "env": { "FILES_ROOT": "/absolute/path/to/yea-scratch" }
    }
  }
}
```
:::

Ask the agent to delete `docs/report.pdf`. Before anything happens, the server sends the client a form (MCP form elicitation) with the plan and a field to type in. How a client shows it is up to the client; we've tested the exchange with the MCP SDK's own client, not yet in a named app. What it says is this:

```text
Approval needed: delete_file can't be undone.

[1] Delete docs/report.pdf
  - delete file/docs/report.pdf
  risk: medium · undo: never
  to approve, type: report.pdf

Confirm: Type "report.pdf" to approve.
```

Type `report.pdf` and the file is deleted. Decline, or type something else three times, and nothing is. **That's the tool guarded.**

Three things to know at this point:

- **The server's stderr warns** `yea: no pinned principal key (YEA_PRINCIPAL_PUB is not set): nothing auto-runs and no consent is accepted`. That's expected: it only matters for steps 5 and 6.
- **The client must support form elicitation** to show the form. The [client table](https://github.com/yea-protocol/yea#client-support) says which clients we've run and what their vendors document. A client without it gets step 6's consent codes instead.
- **A plan at `risk: "high"`**, or an `outOfBand` rule in `~/.yea/policy.json`, is never approved in the chat. It goes to consent codes, which need step 5's pinned key.

## 4. Make it undoable

Deleting can't be undone, so it always asks. Moving a file to a trash folder can, and YEA can offer undo for it. A **job** is a tool written for YEA from the start: its function returns plans, and each plan's `apply` does the work.

<<< ../../python/mcp/examples/mcp_quickstart.py#job

- **The decorated function** returns the plans. It must not change anything: it runs on preview and on every retry. Its parameters are the tool's input, as with `@server.tool()`.
- **`apply()`** runs at most once, and only after the plan is approved or allowed.
- **`revert`** plus an **`undo_window`** make the plan undoable. The first job with `revert` adds an `undo` tool to the server.

Ask the agent to move `docs/notes.txt` to the trash. After approval, the call returns a receipt:

```text
✓ Move docs/notes.txt to the trash (receipt r_Ny6CTkeKuDVI) · undo until 2026-09-29T02:37:30Z
  result:
    file: /Users/me/yea-scratch/docs/notes.txt
    trashedAs: /Users/me/yea-scratch/docs/.trash/b0974c8d-9a52-4c19-acd0-ccb8bc0cef3f-notes.txt
```

The plan refuses anything that isn't a regular file, such as a directory, since `revert` couldn't put it back. `undo(receipt="r_Ny6CTkeKuDVI")` puts the file back, within the window. Undo doesn't ask, because it restores what the person already approved changing. Any job call also takes `"preview": true`, which returns the plans and does nothing.

## 5. Let safe things run on their own

So far everything asks. A **signed policy** lets undoable plans run without asking: for example, *`move_to_trash`, at low risk, for the next seven days*.

The policy is only as strong as the place where your **private** principal key lives: whoever can use that key can sign any policy. So there are two setups.

### The real setup: the key on another OS user or device

1. **On the other user or device,** create the principal key and copy its public key:

   ```sh
   yea init
   yea whoami          # principal ed25519:…
   ```

2. **On the server's machine,** pin that public key where the server's user can't change it:

   ```sh
   sudo mkdir -p /etc/yea && echo 'ed25519:…' | sudo tee /etc/yea/principal.pub
   ```

   The server refuses a pinned key file that its own user could change, or replace through a directory above it.

3. **Get the server's id** from its start-up line on stderr (or `approvals.service_id()` in your code):

   ```text
   yea: service id ed25519:… (name files)
   ```

4. **On the key's side,** sign a policy for that id:

   ```sh
   yea grant --to ed25519:… --can move_to_trash --risk low --exp 7d
   ```

   It prints only the `pg1.` token on stdout. Copy it into a file on the server's machine, for example `/Users/me/.config/yea/files.policy`.

5. **In the client config,** point the server at both:

   ```sh
   claude mcp add files \
     -e FILES_ROOT="$HOME/yea-scratch" \
     -e YEA_PRINCIPAL_PUB=/etc/yea/principal.pub \
     -e YEA_POLICY="$HOME/.config/yea/files.policy" \
     -- uv run python server.py
   ```

   `~` isn't expanded in client config files, so use a full path there, or `$HOME` in a shell as above. The policy is read on every call, so a new one applies without a restart.

Now `move_to_trash` runs straight away and returns its receipt. `delete_file` still asks.

### Trying it on one account (best effort)

The same steps, with `yea init` and `yea grant` run on this account:

```sh
yea init && yea whoami
sudo mkdir -p /etc/yea && echo 'ed25519:…' | sudo tee /etc/yea/principal.pub
mkdir -p "$HOME/.config/yea"
yea grant --to ed25519:… --can move_to_trash --risk low --exp 7d > "$HOME/.config/yea/files.policy"
```

::: danger For trying YEA, not for protecting anything
The principal key is now in `~/.yea` on the account the agent runs as. An agent that can run commands or read files, as Claude Code can, could sign its own policy. Move the key to another OS user or device before you rely on it.
:::

### What a policy can't do

- **Only undoable plans run on their own.** That's why the grant names the step-4 job. The step-2 guard never auto-runs unless its `describe` returns an `undo_window` and it has a `revert`: without them there's no way back from a mistake, so the person decides each time.
- **The person signs the policy, not the agent.** The server trusts only the pinned key, and the agent never holds the private key in the real setup. Unsigned settings in `~/.yea/policy.json` can only tighten it, and a file there that can't be read refuses every job until it's fixed.
- A plan over the policy's risk, a tool it doesn't name, or an expired policy all go back to asking.

## 6. Clients that can't ask

Some clients don't support form elicitation. For them, a call that needs approval fails closed. The model gets the plan and a consent code, and nothing runs:

```text
✗ approval needed: delete_file can't be undone; nothing was run
1 plan:
[1] Delete docs/report.pdf
  - delete file/docs/report.pdf
  risk: medium · undo: never
Ask the user to run `yea approve <code>` in their terminal, then call again.
  code for [1]: pc1.eyJjYXBhYmlsaXR5Ijoi…
```

`yea approve <code>` shows the plan, has the person type its phrase, and signs a one-time consent for that exact plan with the principal key. It saves the consent in the store the server reads (`YEA_STORE`, else `$YEA_HOME/store`, else `~/.yea/store`). When the model calls again with the same input, the call runs once.

So `yea approve` needs both the principal key and the server's store. In the one-account setup, both are on your account, and that's the case our tests cover. With the key on another OS user, that user would run it on the server's machine with `YEA_STORE` set to the server's store; we haven't yet tested a store written by two OS users. A key on another device can't answer a consent code yet.

**Why the pinned key matters here:** the server accepts only consents signed by the pinned principal key. Without one it can't accept any, so it gives no codes and says why:

```text
No consent can be accepted: YEA_PRINCIPAL_PUB is not set.
```

The same happens on a server whose store is in memory (the default over HTTP), because `yea approve` can't reach it.

## FastMCP

`yea-mcp` takes a FastMCP 4 server wherever it takes an `MCPServer`: `@approvals.job(mcp, ...)` and `approvals.guard(mcp, "tool_name", ...)` work the same, with `FastMCP("files", request_state_security=approvals.request_state_security())`. Install the extra: `yea-mcp[fastmcp]` (until the release, `"yea-mcp[fastmcp] @ git+https://github.com/yea-protocol/yea#subdirectory=python/mcp"`). Guard a mounted server's tool on the server that defines it.

## Where to next

- **The full example:** [`python/mcp/examples/mcp_quickstart.py`](../../python/mcp/examples/mcp_quickstart.py), and [From REST to YEA](/guide/service-design) for turning an API's writes into job tools.
- **The security model:** [what must stay out of the agent's reach](/guide/security#mcp-servers-built-with-the-framework).
- **The specs:** [`yea-mcp`](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-mcp-py.md), and the [approval contract](https://github.com/yea-protocol/yea/blob/main/docs/framework/SPEC-approval.md) it implements.
