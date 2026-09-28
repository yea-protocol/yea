"""YEA protocol — independent Python implementation (see ../SPEC.md)."""

from ._json import CanonicalError, b64url_decode, b64url_encode, canonical, compact, proposal_hash
from .budget import HandleStore, MemoryHandleStore, fit
from .client import Client, Reply, connect, local
from .errors import YeaError, fix
from .grants import (
    Grant,
    GrantContext,
    Verification,
    check_consent,
    consent_code,
    consent_grant,
    decode_consent_code,
    decode_grant,
    delegate_grant,
    issue_grant,
    verify_grant,
)
from .keys import KeyPair, generate_key, key_from_seed, sign_proof, verify, verify_proof
from .lens import effect_line, est, fmt_duration, fmt_time, lean, lens, scalar
from .service import (
    Clarification, CommitCtx, Ctx, Plan, Service, clarify, create, remove, send, service, update,
)
from .transport import serve_http, serve_stdio, serve_stream, serve_tcp
from .uses import fmt_quantity, quantity, spend
from .text import clip, one_line, printable
from .validate import validate_params

__version__ = "0.1.0"

__all__ = [
    "CanonicalError", "Clarification", "Client", "CommitCtx", "Ctx", "Grant", "GrantContext", "HandleStore", "KeyPair",
    "MemoryHandleStore", "YeaError", "Plan", "Reply", "Service", "Verification", "b64url_decode", "b64url_encode",
    "canonical", "clarify", "clip", "compact", "check_consent", "connect", "consent_code", "consent_grant", "decode_consent_code", "create", "decode_grant", "delegate_grant",
    "effect_line", "est", "fit", "fix", "fmt_duration", "fmt_quantity", "fmt_time", "generate_key", "issue_grant",
    "key_from_seed", "lean", "lens", "local", "one_line", "printable", "proposal_hash", "quantity", "remove", "scalar", "send", "serve_http",
    "serve_stdio", "serve_stream", "serve_tcp", "service", "sign_proof", "spend", "update", "validate_params", "verify",
    "verify_grant", "verify_proof",
]
