# region quickstart
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
# endregion quickstart
