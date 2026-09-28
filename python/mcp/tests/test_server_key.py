"""The server key file: what is accepted and what is refused (SPEC-mcp-py `server_key`), as the
private-key-file tests in ts/test/security.test.ts."""

from __future__ import annotations

import os

import pytest

from yea_mcp import keys
from yea_mcp.keys import load_server_key

SEED = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"


def key_at(tmp_path, text=SEED + "\n", mode=0o600):
    d = tmp_path / "server"
    d.mkdir(mode=0o700, exist_ok=True)
    p = d / "s.key"
    p.write_text(text)
    os.chmod(p, mode)
    return p


def test_0600_and_0400_are_accepted(tmp_path):
    assert load_server_key(key_at(tmp_path)).public
    assert load_server_key(key_at(tmp_path, mode=0o400)).public


@pytest.mark.parametrize("mode", [0o640, 0o604, 0o660, 0o620, 0o644])
def test_a_key_others_can_reach_is_refused(tmp_path, mode):
    with pytest.raises(ValueError, match=r"can be read by other users \(chmod 600 it\)"):
        load_server_key(key_at(tmp_path, mode=mode))


def test_a_symlink_even_a_dangling_one_is_refused(tmp_path):
    d = tmp_path / "server"
    d.mkdir(mode=0o700)
    (tmp_path / "elsewhere").mkdir()
    real = key_at(tmp_path / "elsewhere")
    (d / "good.key").symlink_to(real)
    (d / "dangling.key").symlink_to(tmp_path / "nothing-here")
    for name in ("good.key", "dangling.key"):
        with pytest.raises(ValueError, match="is a symlink or unreadable"):
            load_server_key(d / name)


def test_a_directory_is_refused(tmp_path):
    d = tmp_path / "server"
    (d / "s.key").mkdir(parents=True, mode=0o700)
    os.chmod(d, 0o700)
    with pytest.raises(ValueError, match="not a regular file"):  # it used to raise IsADirectoryError
        load_server_key(d / "s.key")


def test_a_fifo_is_refused_without_hanging(tmp_path):
    d = tmp_path / "server"
    d.mkdir(mode=0o700)
    os.mkfifo(d / "s.key", 0o600)
    with pytest.raises(ValueError, match="not a regular file"):
        load_server_key(d / "s.key")


def test_a_key_owned_by_someone_else_is_refused(tmp_path, monkeypatch):
    p = key_at(tmp_path)
    real = os.geteuid()
    monkeypatch.setattr(keys.os, "geteuid", lambda: real + 1)
    with pytest.raises(ValueError, match="is not owned by this user|must be a directory owned by this user"):
        load_server_key(p)


def test_a_file_that_is_not_a_seed_is_refused(tmp_path):
    with pytest.raises(ValueError, match="does not hold an Ed25519 seed"):
        load_server_key(key_at(tmp_path, text="not a seed\n"))


def test_a_key_file_over_64_kib_is_refused(tmp_path):
    with pytest.raises(ValueError, match="is larger than 64 KiB, too big for a key file"):
        load_server_key(key_at(tmp_path, text=SEED + "\n" + "x" * (64 * 1024)))


def test_without_file_owners_it_warns_once_and_reads(tmp_path, monkeypatch, capsys):
    """Windows has no owners or mode bits: say so on stderr, as mcp-ts, rather than pass silently."""
    p = key_at(tmp_path)
    monkeypatch.delattr(keys.os, "geteuid")
    monkeypatch.setattr(keys, "_warned", set())
    assert load_server_key(p).public
    load_server_key(p)
    err = capsys.readouterr().err
    assert err.count("can't check who owns") == 1 and "keep it private yourself" in err
