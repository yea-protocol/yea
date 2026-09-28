"""The agent side: connect to a service and speak YEA.

The entry of the ``yea.client`` package: it re-exports the parts, each one job per module."""

from __future__ import annotations

from .connect import connect
from .reply import OnEvent, Reply
from .session import Client
from .transports import local

__all__ = [
    "OnEvent",
    "Reply",
    "local",
    "Client",
    "connect",
]
