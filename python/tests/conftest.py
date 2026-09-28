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
