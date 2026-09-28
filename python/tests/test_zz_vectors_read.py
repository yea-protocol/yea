"""Every conformance vector file is loaded, and each object file's top-level sections are exactly
the ones the tests read, so a section the TS generator adds can't go unchecked here and one it
drops can't silently skip its test. Mirrors the section-key check in ts/test/conformance.test.ts.
Named to run after the tests that read them."""

import pytest
from conftest import CONFORMANCE, DESELECTED_READERS, LOADED, READ, READERS, load_vectors


def _whole_run(request) -> bool:
    """True when every reader test was selected and runs before this one."""
    items = request.session.items
    if DESELECTED_READERS or items[-1] is not request.node:
        return False
    if any("::" in a and a.split("::")[0].endswith(READERS) for a in request.config.args):
        return False  # tests picked by node id within a reader file
    return set(READERS) <= {item.path.name for item in items}


def test_every_vector_file_is_loaded_and_every_section_read(request):
    if not _whole_run(request):
        pytest.skip("needs the whole conformance run")
    files = sorted(p.stem for p in CONFORMANCE.glob("*.json"))
    assert [f for f in files if f not in LOADED] == []
    for name in files:
        data = load_vectors(name)
        if isinstance(data, dict):
            assert sorted(READ[name]) == sorted(dict.keys(data)), f"{name}.json: sections read vs present"
