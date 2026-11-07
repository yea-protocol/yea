"""Closed options (SPEC-mcp-py, "Closed options"). The keyword arguments are closed by their
signatures; this closes the dicts inside them, ``tighten`` and ``annotations``, and the ``risk``
values. A refusal raises before anything is registered, served or written, naming the key and what
it takes: ``TypeError`` for an unknown key or a value of the wrong type, ``ValueError`` for a value
outside its set, as for ``transport``."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any, NamedTuple

import mcp_types as t
from yea.approval import RISK_ORDER

RISKS = "'low', 'medium' or 'high'"


class Rule(NamedTuple):
    """What one key takes: ``says`` it in the error, ``ok`` checks it, and ``error`` is raised."""

    says: str
    ok: Callable[[Any], bool]
    error: type[Exception] = TypeError


def _is_risk(v: Any) -> bool:
    return isinstance(v, str) and v in RISK_ORDER


A_RISK = Rule(RISKS, _is_risk, ValueError)
A_STRING = Rule("a string", lambda v: isinstance(v, str))
A_BOOL = Rule("True or False", lambda v: isinstance(v, bool))

TIGHTEN = {
    "deny": Rule("a list of strings", lambda v: isinstance(v, list) and all(isinstance(s, str) for s in v)),
    "outOfBand": A_RISK,
}

# ToolAnnotations' fields, by their wire names, as the job defaults are merged under them.
ANNOTATIONS = {
    "title": A_STRING,
    "readOnlyHint": A_BOOL,
    "destructiveHint": A_BOOL,
    "idempotentHint": A_BOOL,
    "openWorldHint": A_BOOL,
}


def check_dict(where: str, name: str, value: dict, rules: dict[str, Rule]) -> None:
    """Raise unless ``value`` has only the keys in ``rules``, each as its rule says. ``where`` names
    the function, as in ``yea()``; ``name`` the option, the path an error names (``tighten.deny``)."""
    unknown = next((k for k in value if k not in rules), None)
    if unknown is not None:
        known = ", ".join(f"{name}.{k}" for k in rules)
        raise TypeError(f"{where}: unknown option {json.dumps(f'{name}.{unknown}')}; known: {known}")
    for key, rule in rules.items():
        if key in value and not rule.ok(value[key]):
            raise rule.error(f"{where}: {name}.{key} must be {rule.says}")


def check_tighten(where: str, tighten: Any) -> None:
    """``tighten``: None, or a dict of ``deny`` and ``outOfBand``, as ``policy.json`` is written."""
    if tighten is None:
        return
    if not isinstance(tighten, dict):
        raise TypeError(f"{where}: tighten must be a dict")
    check_dict(where, "tighten", tighten, TIGHTEN)


def check_annotations(where: str, annotations: Any) -> None:
    """``annotations``: None, a ``ToolAnnotations`` (pydantic checked it), or a dict of its fields by
    their wire names. pydantic alone would ignore an unknown key and coerce ``"yes"`` to True."""
    if annotations is None or isinstance(annotations, t.ToolAnnotations):
        return
    if not isinstance(annotations, dict):
        raise TypeError(f"{where}: annotations must be a dict or a ToolAnnotations")
    check_dict(where, "annotations", annotations, ANNOTATIONS)


def check_risk(where: str, risk: Any) -> None:
    """``risk``: None (the default, ``medium``), or a risk."""
    if risk is not None and not _is_risk(risk):
        raise ValueError(f"{where}: risk must be {RISKS}")
