"""A shop whose orders report what they spend, served for ts/test/interop-python.test.ts (#405): a TS
grant's periodic ``total`` counts in this Python service's ledger. The example calendar reports no
``uses``, so a ``total`` binds nothing there.

    YEA_TRUST=ed25519:... uv run python tests/interop_shop.py

It binds a free port on HOST (default 127.0.0.1) and names it on stderr.
"""

from __future__ import annotations

import asyncio
import os
import sys

from yea import Plan, Service, create, quantity, serve_tcp

PRICE = quantity(1500, scale=2, unit="USD")


def shop(trust: list[str]) -> Service:
    """``shop.order``: one item for 15.00 USD, undoable for ten minutes."""
    svc = Service("shop.example", "Interop Shop", "Orders that report what they spend.", trust=trust)
    orders: list[str] = []

    @svc.intent("shop.order", "Order one item", {"sku": "string"}, risk="low")
    def order(ctx):
        sku = ctx.params["sku"]

        def apply(_ctx):
            orders.append(sku)
            return {"order": len(orders)}

        return Plan(f"Order {sku}", [create(f"order/{sku}")], apply, uses={"spend": PRICE},
                    revert=lambda _ctx: orders.pop(), undo_window=600)

    return svc


async def main() -> None:
    trust = [k for k in os.environ.get("YEA_TRUST", "").split(",") if k]
    server = await serve_tcp(shop(trust), os.environ.get("HOST", "127.0.0.1"), 0)
    host, port = server.sockets[0].getsockname()[:2]
    print(f"yea python interop shop up · yea://{host}:{port}", file=sys.stderr, flush=True)
    await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
