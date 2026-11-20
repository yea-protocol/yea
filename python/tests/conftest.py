import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "examples"))
CONFORMANCE = ROOT.parent / "conformance"

# Which vector files the tests loaded, and which top-level sections of each object file they read
# (test_zz_vectors_read.py checks that nothing was left unread, like ts/test/conformance.test.ts).
LOADED: set[str] = set()
READ: dict[str, set[str]] = {}
READERS = (
    "test_conformance.py", "test_approval_conformance.py", "test_job_call_conformance.py", "test_commit_ledger_conformance.py"
)
DESELECTED_READERS: list[str] = []


def pytest_deselected(items):
    """A deselected reader test (-k, --deselect, --lf) means some sections may go unread."""
    DESELECTED_READERS.extend(i.nodeid for i in items if i.path.name in READERS)


class Sections(dict):
    """A vector file's top-level object, recording each section a test reads."""

    def __init__(self, name: str, data: dict):
        super().__init__(data)
        self.name = name

    def __getitem__(self, key):
        READ[self.name].add(key)
        return super().__getitem__(key)

    def get(self, key, default=None):
        READ[self.name].add(key)
        return super().get(key, default)


def load_vectors(name: str):
    """conformance/<name>.json, or None when it's missing. An object file records the sections read."""
    path = CONFORMANCE / f"{name}.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    LOADED.add(name)
    if isinstance(data, dict):
        READ.setdefault(name, set())
        return Sections(name, data)
    return data


def ledger_key(d: dict):
    """A vector's ledger key, ``{block, of, period?: {every, start}}``, as a ``LedgerKey``."""
    from yea.grants import LedgerKey, Period

    p = d.get("period")
    return LedgerKey(d["block"], d["of"], Period(p["every"], p["start"]) if p else None)


def ledger_key_json(k) -> dict:
    """A ``LedgerKey`` as the vectors write it, in the TS reference's key order."""
    return {"block": k.block, "of": k.of, **({"period": k.period._asdict()} if k.period else {})}


def used_at(used: dict, k) -> int:
    """The exact amount a vector's ``used`` holds for key ``k``, written as FileStore lays the ledger
    out: ``{"spend": q}``, or ``{"spend@604800": {"1789776000": q}}`` for one period of a total."""
    from yea.uses import value

    q = used.get(f"{k.of}@{k.period.every}", {}).get(str(k.period.start)) if k.period else used.get(k.of)
    return value(q) if q else 0
