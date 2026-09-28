"""Every conformance vector file is loaded, and every top-level section of each object file is
read by some test, so a section the TS generator adds can't go unchecked here. Mirrors the
section-key check in ts/test/conformance.test.ts. Named to run after the tests that read them."""

import pytest
from conftest import CONFORMANCE, LOADED, READ, load_vectors

READERS = {"test_conformance.py", "test_approval_conformance.py"}


def _whole_run(request) -> bool:
    """True when every test in the reader modules was selected (no -k, -m or single-file run)."""
    if request.config.getoption("keyword") or request.config.getoption("markexpr"):
        return False
    return READERS <= {item.path.name for item in request.session.items}


def test_every_vector_file_is_loaded_and_every_section_read(request):
    if not _whole_run(request):
        pytest.skip("needs the whole conformance run")
    files = sorted(p.stem for p in CONFORMANCE.glob("*.json"))
    assert [f for f in files if f not in LOADED] == []
    for name in files:
        data = load_vectors(name)
        if isinstance(data, dict):
            assert sorted(set(dict.keys(data)) - READ[name]) == [], f"{name}.json sections no test reads"
