<img alt="YEA" src="https://raw.githubusercontent.com/yea-protocol/yea/main/docs/brand/logo-light.svg" height="48">

# yea-sdk (Python)

**The Python implementation of [YEA](https://github.com/yea-protocol/yea)** (*Your Explicit
Approval*), the open protocol for AI agents acting on behalf of people. Agents state an intent,
services reply with proposals whose effects are listed up front, the person's signed policy
decides what can go ahead without asking, and reversible commits come with an undo window.
Guarding the tools of an MCP server instead? That's
[`yea-mcp`](https://yea-protocol.github.io/yea/guide/mcp-python).
[Docs](https://yea-protocol.github.io/yea/guide/python) ·
[Spec](https://github.com/yea-protocol/yea/blob/main/SPEC.md)

> **Unreleased:** `yea-sdk` isn't on PyPI yet. Until it is, install it from the repo:
>
> ```sh
> uv add "git+https://github.com/yea-protocol/yea#subdirectory=python"
> ```

```sh
uv add yea-sdk  # or: pip install yea-sdk. It imports as `yea`.
```

## Quickstart

<!-- snippet: python/examples/quickstart.py#quickstart -->
```python
"""A calendar service, and an agent that moves a meeting and undoes it, in one process.

    uv run python examples/quickstart.py
"""

import asyncio

from yea import Client, Plan, Service, generate_key, issue_grant, local, send, update

# Normally the person's key stays with them, and the agent has its own.
principal, agent = generate_key(), generate_key()
svc = Service("cal.example", "Calendar", "Move meetings.", trust=[principal.public])


@svc.intent("calendar.move", "Move a meeting",
            {"event": "string", "to": "datetime"}, risk="low")
def move(ctx):
    e, to = ctx.params["event"], ctx.params["to"]
    effects = [update(f"event/{e}", "start", "…", to), send("ana@x.co", "invite")]
    return Plan(f"Move {e} to {to}", effects, apply=lambda c: {"moved": e},
                revert=lambda c: None, undo_window=3600)


async def main() -> None:
    # The person's policy: this agent may act at cal.example.
    grant = issue_grant(principal, agent.public, [{"svc": ["cal.example"]}])
    # In-process here; over a network, connect("yea://host:port", key=…, grants=…).
    async with Client(local(svc), key=agent, grants=[grant]) as c:
        when = {"event": "e2", "to": "2026-09-24T15:00:00Z"}
        props = await c.intent("calendar.move", when)
        print(props.lens)  # what the model reads
        r = await c.commit(props.proposals[0])  # signs the proof; the grant allows it
        print(r.lens)
        print((await c.undo(r.receipt["id"])).lens)


if __name__ == "__main__":
    asyncio.run(main())
```

The agent reads `props.lens`, the plan as text, and commits it, signing a proof with its key.
The person's grant allows it here; a commit it doesn't allow comes back `consent_required`. The
person reviews that plan with `consent_lines` and signs a one-time consent with `consent_grant`
in their own tool, never somewhere the agent can trigger it (SPEC §6.6). Over a network, the
service runs with `serve_tcp` or `serve_http` (`POST /yea`).

## Where it fits

It's checked against the shared
[conformance vectors](https://github.com/yea-protocol/yea/tree/main/conformance), and tested for
interop, in both directions, against the TypeScript reference (from a checkout:
`cd python && uv run pytest`, with Node 22.18 or later). Python 3.10 or later; its only dependency
is `cryptography`.

API names mirror `ts/src` in snake_case (`issue_grant`, `verify_grant`, `consent_grant`,
`lean`, `lens`, `fit`, `Plan.expires_in`/`undo_window`).
[`examples/serve.py`](https://github.com/yea-protocol/yea/blob/main/python/examples/serve.py)
runs the shared example calendar on `yea://127.0.0.1:7457` and `http://127.0.0.1:8457/yea`.

The `yea` command (`yea grant`, `yea approve`, the MCP bridge `yea mcp`) and the OpenAPI adapter
ship with the TypeScript packages, as
[`@yea-protocol/cli`](https://www.npmjs.com/package/@yea-protocol/cli).
