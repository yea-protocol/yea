"""Shared pending-file vectors (../conformance/pending.json, SPEC-approval §6 Short ids): the
Python writer makes the same files as the TypeScript ones."""

import os
import re
import stat

import pytest
from conftest import CONFORMANCE, load_vectors

from yea.store import (
    PENDING_ID,
    FileStore,
    MemoryStore,
    PendingCodes,
    new_pending_id,
    pending_codes_of,
    pending_file,
)

PATH = CONFORMANCE / "pending.json"
DATA = load_vectors("pending")
pytestmark = pytest.mark.skipif(DATA is None, reason=f"{PATH} missing")


def test_format_and_place(tmp_path):
    assert str(pending_codes_of(FileStore(tmp_path)).dir) == DATA["dirs"]["server"].replace("<store>", str(tmp_path))
    assert pending_codes_of(MemoryStore()) is None
    assert PENDING_ID.pattern == DATA["readId"]
    assert re.fullmatch(DATA["writtenId"], new_pending_id())
    assert pending_file(DATA["file"]["code"]) == DATA["file"]["text"]


def test_ops(tmp_path):
    """Replay the ops: the same ids by label, the same files after each, and never the agent seed."""
    store, ids = PendingCodes(tmp_path / "pending"), {}
    for o in DATA["ops"]:
        if o["op"] == "put":
            got = store.put(DATA["codes"][o["code"]], o["now"])
            assert got == ids.get(o["as"], got), o
            ids[o["as"]] = got
        else:
            store.drop(o["service"], o["proposal"])
        by_id = {v: k for k, v in ids.items()}
        files = {by_id[p.name]: p.read_text(encoding="utf-8") for p in store.dir.iterdir()}
        assert files == {k: DATA["codes"][c] + "\n" for k, c in o["files"].items()}, o
        assert DATA["agentSeed"] not in "".join(files.values())


@pytest.mark.skipif(os.name != "posix", reason="mode bits")
def test_private(tmp_path):
    store = PendingCodes(tmp_path / "pending")
    i = store.put(DATA["file"]["code"], DATA["ops"][1]["now"])
    assert stat.S_IMODE(os.stat(store.dir).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(store.dir / i).st_mode) == 0o600


def test_leaves_what_it_cant_read(tmp_path):
    """A symlink, an oversize file or a file that isn't a code is never read as one, nor removed."""
    store = PendingCodes(tmp_path / "pending")
    store.dir.mkdir()
    (store.dir / "aaaaaaaaaa").write_text("x" * (DATA["maxBytes"] + 1))
    (store.dir / "bbbbbbbbbb").write_text("not a code\n")
    (tmp_path / "elsewhere").write_text(DATA["codes"]["old"] + "\n")
    os.symlink(tmp_path / "elsewhere", store.dir / "cccccccccc")
    store.put(DATA["codes"]["plan"], DATA["ops"][1]["now"])
    assert {"aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"} <= {p.name for p in store.dir.iterdir()}
    assert (tmp_path / "elsewhere").exists()
