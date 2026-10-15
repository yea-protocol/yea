"""Reading a request frame (SPEC §2.1, §3, §4): the envelope, the verb and the fields that verb
reads, from the frame alone. Covered by ``conformance/requests.json`` (like
ts/src/service/verified-request/parse.ts)."""

from __future__ import annotations

from typing import Any

from ..._json import MAX_SAFE_INT, has_lone_surrogate
from ...errors import YeaError, fix
from ..util import _json_str, _positive_int

VERBS = ("HELLO", "ASK", "INTENT", "COMMIT", "UNDO", "EXPAND")


def parse_request(frame: Any) -> dict:
    """A request frame, read: its fields for its verb, nothing verified yet. Raises ``bad_frame`` or
    ``invalid_params`` when the frame alone is wrong. A name the verb looks up (``capability``,
    ``proposal``, ``hash``, ``receipt``, ``handle``) is None when missing or not a string, so the
    lookup fails as it would for an unknown name. ``budget`` is None unless a whole number above 0. A
    malformed ``grants`` is a ``bad_frame`` even when ``params`` is wrong too."""
    f = _envelope(frame)
    verb = f.get("verb")
    out: dict[str, Any] = {"verb": verb, "id": f["id"], "budget": _positive_int(f.get("budget"))}
    if verb == "HELLO":
        return out
    grants = _grants(f.get("grants")) if verb in ("ASK", "INTENT", "COMMIT", "UNDO") else []
    if verb in ("ASK", "INTENT"):
        out["capability"] = _name(f.get("capability"))
        out["params"] = _params(f.get("params"))
        if verb == "INTENT":
            goal = f.get("goal")
            out["goal"] = goal if isinstance(goal, str) else None
            out["auto"] = f.get("auto") is True  # `true` itself, not merely truthy (§4.3.1)
    elif verb == "COMMIT":
        out["proposal"] = _name(f.get("proposal"))
        out["hash"] = _name(f.get("hash"))
    elif verb == "UNDO":
        out["receipt"] = _name(f.get("receipt"))
    elif verb == "EXPAND":
        out["handle"] = _name(f.get("handle"))
        out["proof"] = _proof(f.get("proof"))
        return out
    else:
        raise YeaError("bad_frame", f"unknown verb {_json_str(verb)}", fix=[fix("use one of " + ", ".join(VERBS))])
    out["grants"] = grants
    out["proof"] = _proof(f.get("proof"))
    return out


def _envelope(frame: Any) -> dict:
    """The envelope every request needs (§2.1), with no lone surrogate anywhere (§10)."""
    # `true` is not 1 in JSON, though Python's `True == 1`.
    yea = frame.get("yea") if isinstance(frame, dict) else None
    if not isinstance(frame, dict) or isinstance(yea, bool) or yea != 1 or not isinstance(frame.get("id"), str):
        raise YeaError("bad_frame", 'frames need "yea": 1 and a string "id"')
    # A lone surrogate has no canonical form: refuse the frame here, before a handler hashes it
    # and fails as `internal`.
    if has_lone_surrogate(frame):
        raise YeaError("bad_frame", "a string holds a lone surrogate")
    return frame


def _name(v: Any) -> str | None:
    return v if isinstance(v, str) else None


def _params(params: Any) -> dict:
    """A request's params: ``{}`` when absent or null, and otherwise an object (§4.2, §4.3)."""
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise YeaError("invalid_params", "`params` must be an object")
    return params


def _grants(grants: Any) -> list[str]:
    """A request's grants (§3). Only a missing, null or empty ``grants`` is none; anything else must
    be a list of strings, or the request is a ``bad_frame``."""
    if grants is None:
        return []
    if not isinstance(grants, list) or not all(isinstance(g, str) for g in grants):
        raise YeaError("bad_frame", "`grants` must be a list of strings")
    return grants


def _proof(proof: Any) -> dict | None:
    """A proof of the shape §6.5 gives it, or None. Only its shape is read here; a malformed one
    fails as a missing proof when a grant needs it."""
    if not isinstance(proof, dict):
        return None
    key, ts, sig = proof.get("key"), proof.get("ts"), proof.get("sig")
    if not isinstance(key, str) or not isinstance(sig, str) or type(ts) is not int or abs(ts) > MAX_SAFE_INT:
        return None
    return {"key": key, "ts": ts, "sig": sig}
